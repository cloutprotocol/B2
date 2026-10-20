//! B² (BORDR Pair) end to end, in LiteSVM with Bordrless's own harness (bordrless-program-tests),
//! on the Bordrless programs dumped from mainnet into fixtures/ (native SOL, 17 Oct 2026), mainnet's
//! rent, Bordrless's live wBORDR/SOL pool cloned from mainnet, and both halves as `cargo build-sbf`
//! builds them:
//!
//! - a pair launch: the companion made with the script (keeper.json's stateLen and stepSecs), the
//!   hook prepared (its registry naming the launch pool's LP mint and the launch's LP holding), a
//!   SOL-cut config naming the hook (hook.json's caps), the companion's launch;
//! - on the curve: the SOL cut (1%; Dip Buy 0% / 3%), no hook data (holdings close), the pot's
//!   small buys held after the sniper window (1% of the curve's depth, the guards, the cap of half
//!   the pot, no SOL cut on them), the dip bought for the liquidity after two observations, idle
//!   steps failing;
//! - graduation: the held coin half to the launch pool (with pot SOL, the LP locked in the
//!   launch's holding) and half to coin/wBORDR (wBORDR bought on the live pool, the pool created
//!   and added to, its LP locked), then 50/50;
//! - the coin/wBORDR pool made first by someone else at another price, or traded off it: healed
//!   by the script's own trade, then added to; with no wBORDR/SOL pool or no DEX config to create
//!   the pair pool, the pot going on to the launch pool;
//! - every lamport the pot spends going into the liquidity (the builder's wallet paid nothing by
//!   the script; its builder share comes from the launcher's part of a claim), the guards, steps
//!   built short,
//!   the tx size with a lookup table, the call depth and the instruction trace; every builder
//!   against the DEX's and the bridge's clients, every constant key against its derivation.

use anchor_lang::prelude::{AccountMeta, Pubkey};
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountDeserialize, InstructionData, Space, ToAccountMetas};
use bordrless_companion::client as companion;
use bordrless_companion::constants::{APPROVAL_KIND_SCRIPT, SCRIPT_BOUNTY};
use bordrless_companion::events::ScriptStepped;
use bordrless_companion::instructions::{CreateArgs, CreateScriptArgs};
use bordrless_companion::state::{Companion, Split};
use bordrless_core::policy;
use bordrless_launch::client::{self as launch, LaunchKeys};
use bordrless_launch::constants::{HOOK_UPGRADE_AUTHORITIES, STATUS_GRADUATED};
use bordrless_launch::instructions::CreateConfigArgs;
use bordrless_launch::state::{LaunchRules, QuoteCut};
use bordrless_program_tests::env::{compute_unit_limit, Tx, SYSTEM_PROGRAM_ID};
use bordrless_program_tests::fixture::World;
use bordrless_program_tests::launch::{SOL, VQ};
use bordrless_program_tests::spl;
use bordrless_swap::client as swap;
use bordrless_token::client as token;
use bordrless_token::state::Holding;
use my_hook as hook;
use solana_keypair::Keypair;
use solana_signer::Signer;
use workshop_script as script;
use workshop_script::{action, PairState};

/// BORDR on SPL (the real mint's address and decimals).
const BORDR: Pubkey = Pubkey::from_str_const("6Mix12LiHrQFojaQEnfPUC65Qkwd6X4Y5Qg93oFbordr");
/// wBORDR, the bridge's twin of BORDR.
const WBORDR: Pubkey = script::WBORDR_MINT;
/// Bordrless's wBORDR/SOL native pool, live on mainnet at 30 bps (cloned in fixtures/accounts).
const WBORDR_POOL: Pubkey = Pubkey::from_str_const("BtVzohbo3J6sBqk3L8MQVEKP4Bzg1YPmqX3Pc3oWxKnL");
/// The builder's wallet (the Workshop's earning wallet): paid the builder share by claims, never by
/// the script.
const BUILDER: Pubkey = Pubkey::from_str_const("5opKD1pbKzi98T2wvohsgzWPTS7AzYY1ys1xx2Nygfr3");
/// The pair's launch config: a creator fee of 1% (four quarters of a percent).
const CREATOR_FEE_BPS: u16 = 100;
/// hook.json's caps.
const CUT: QuoteCut = QuoteCut {
    max_buy_bps: 100,
    max_sell_bps: 300,
};
/// The hook's flags, as Bordrless reads them from the source: before_transfer (answering nothing).
const FLAGS: u16 = 1;

/// keeper.json, as submitted.
fn keeper() -> serde_like::Keeper {
    serde_like::read(&std::fs::read_to_string(root().join("script/keeper.json")).expect("keeper.json"))
}

/// A tiny reader of the keeper.json fields the tests use (the SDK validates the file itself).
mod serde_like {
    pub struct Keeper {
        pub step_secs: i64,
        pub state_len: u32,
        pub launcher_share_bps: u16,
        pub mint_writable: bool,
        /// Each of `pools`' `feeBps`, in order.
        pub pool_fees: Vec<u16>,
    }
    fn number(text: &str, key: &str) -> i64 {
        let at = text.find(&format!("\"{key}\"")).unwrap_or_else(|| panic!("keeper.json has {key}"));
        let rest = &text[at + key.len() + 2..];
        let rest = &rest[rest.find(':').expect(":") + 1..];
        let digits: String = rest.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().expect("a number")
    }
    pub fn read(text: &str) -> Keeper {
        Keeper {
            step_secs: number(text, "stepSecs"),
            state_len: u32::try_from(number(text, "stateLen")).expect("u32"),
            launcher_share_bps: u16::try_from(number(text, "launcherShareBps")).expect("u16"),
            mint_writable: text.contains("\"mintWritable\": true"),
            pool_fees: text
                .match_indices("\"feeBps\"")
                .map(|(at, _)| u16::try_from(number(&text[at..], "feeBps")).expect("u16"))
                .collect(),
        }
    }
}

fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// A half's build: hook/target/deploy/my_hook.so, target/deploy/workshop_script.so.
fn so(path: &str) -> Vec<u8> {
    std::fs::read(root().join(path)).unwrap_or_else(|e| panic!("{path}: {e}; build first: scripts/build.sh"))
}

/// An account cloned from mainnet (`solana account -u mainnet-beta <key> --output json-compact`,
/// saved as fixtures/accounts/<key>.json).
fn mainnet_account(key: &Pubkey) -> solana_account::Account {
    let text = std::fs::read_to_string(root().join(format!("fixtures/accounts/{key}.json")))
        .unwrap_or_else(|e| panic!("fixtures/accounts/{key}.json: {e}"));
    let field = |name: &str| -> &str {
        let at = text.find(&format!("\"{name}\":")).unwrap_or_else(|| panic!("{name} in {key}")) + name.len() + 3;
        &text[at..]
    };
    let data = field("data");
    let b64 = &data[data.find('"').unwrap() + 1..];
    let b64 = &b64[..b64.find('"').unwrap()];
    let lamports: String = field("lamports").chars().take_while(|c| c.is_ascii_digit()).collect();
    let owner = field("owner");
    let owner = &owner[1..owner[1..].find('"').unwrap() + 1];
    solana_account::Account {
        lamports: lamports.parse().unwrap(),
        data: base64_decode(b64),
        owner: owner.parse().unwrap(),
        executable: false,
        rent_epoch: u64::MAX,
    }
}

fn base64_decode(text: &str) -> Vec<u8> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes().filter(|c| *c != b'=') {
        acc = (acc << 6) | A.iter().position(|a| *a == c).expect("base64") as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// Mainnet's rent (the Rent sysvar cloned on 17 Oct 2026: 5,080 lamports a byte, against
/// LiteSVM's 6,960), which the live accounts' lamports and a native pool's invariant are measured
/// against.
#[allow(deprecated)]
fn mainnet_rent(w: &mut World) {
    let key = Pubkey::from_str_const("SysvarRent111111111111111111111111111111111");
    let raw = mainnet_account(&key).data;
    let rent = solana_rent::Rent {
        lamports_per_byte: u64::from_le_bytes(raw[0..8].try_into().unwrap()),
        exemption_threshold: raw[8..16].try_into().unwrap(),
        burn_percent: raw[16],
    };
    assert_eq!(rent.lamports_per_byte, 5_080);
    w.env.svm.set_sysvar(&rent);
    assert_eq!(w.env.rent(204), 1_686_560, "a holding's rent, as on mainnet");
}

fn ro(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, false)
}

fn rw(key: Pubkey) -> AccountMeta {
    AccountMeta::new(key, false)
}

/// `ix`'s accounts and program as remaining accounts, nobody a signer.
fn metas(ix: &Instruction) -> Vec<AccountMeta> {
    let mut m: Vec<AccountMeta> = ix
        .accounts
        .iter()
        .map(|a| AccountMeta {
            pubkey: a.pubkey,
            is_signer: false,
            is_writable: a.is_writable,
        })
        .collect();
    m.push(ro(ix.program_id));
    m
}

fn prepare_ix(payer: Pubkey, mint: Pubkey) -> Instruction {
    Instruction {
        program_id: hook::ID,
        accounts: hook::accounts::Prepare {
            payer,
            mint,
            state: hook::state_address(&mint),
            registry: bordrless_hook::hook_accounts_address(&hook::ID, &mint).0,
            system_program: SYSTEM_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: hook::instruction::Prepare {}.data(),
    }
}

/// A launched pair: the world, the coin, its launcher (the beneficiary) and the script's author.
struct Pair {
    w: World,
    mint: Pubkey,
    launcher: Keypair,
    author: Keypair,
    cranker: Keypair,
    /// A holder of BORDR (wrapped as wBORDR): Bordrless's own liquidity for the wBORDR/SOL pool.
    bordr_holder: Keypair,
    /// One coin holding the keeper brings (keeper.json `holdings`: any holder; read by nobody).
    some_holder: Pubkey,
}

impl Pair {
    /// The world with both halves loaded as Bordrless deploys them (upgradeable only by its key),
    /// the script approved (its author named), native launches on, BORDR bridged, then the pair
    /// launched: the companion with the script, `prepare`, the SOL-cut config, the launch.
    fn launched() -> Self {
        let mut w = World::new();
        mainnet_rent(&mut w);
        let bordrless_key = HOOK_UPGRADE_AUTHORITIES[0];
        w.env
            .svm
            .add_program(hook::ID, &so("hook/target/deploy/my_hook.so"))
            .expect("load the hook");
        w.env.set_upgrade_authority(hook::ID, Some(bordrless_key));
        w.env
            .svm
            .add_program(script::ID, &so("target/deploy/workshop_script.so"))
            .expect("load the script");
        w.env.set_upgrade_authority(script::ID, Some(bordrless_key));
        let author = w.env.funded(SOL);
        let deployer = w.env.deployer.insecure_clone();
        let hash = bordrless_program_tests::timelock::programdata_hash(&w.env, &script::ID);
        w.env
            .send(
                &[companion::approve(deployer.pubkey(), script::ID, APPROVAL_KIND_SCRIPT, hash, author.pubkey())],
                &[&deployer],
            )
            .ok();
        let admin = w.admin().pubkey();
        w.as_admin(launch::set_native_launches(admin, true)).ok();

        // BORDR on SPL (6 decimals), registered on the bridge: wBORDR at its real address.
        let bordr_authority = Keypair::new();
        w.env.set_spl_mint(BORDR, Some(bordr_authority.pubkey()), 6, 1_000_000_000_000_000);
        let payer = w.env.payer.insecure_clone();
        w.env
            .send(
                &[bordrless_bridge::client::register(
                    payer.pubkey(),
                    BORDR,
                    spl::TOKEN_PROGRAM_ID,
                    bordrless_bridge::instructions::RegisterArgs {
                        name: "Bordrless".to_string(),
                        symbol: "BORDR".to_string(),
                        uri: String::new(),
                    },
                )],
                &[&payer],
            )
            .ok();
        assert_eq!(bordrless_bridge::client::wrapped_mint_address(&BORDR), WBORDR);
        let bordr_holder = w.env.funded(1_000 * SOL);
        let ata = w.env.set_spl_ata(&bordr_holder.pubkey(), &BORDR, 100_000_000_000_000);
        w.env
            .send_paid_by(
                &[
                    token::create_holding(bordr_holder.pubkey(), WBORDR, bordr_holder.pubkey()),
                    bordrless_bridge::client::wrap(
                        bordr_holder.pubkey(),
                        BORDR,
                        spl::TOKEN_PROGRAM_ID,
                        ata,
                        100_000_000_000_000,
                    ),
                ],
                &bordr_holder,
                &[],
            )
            .ok();
        assert_eq!(w.env.holding(&WBORDR, &bordr_holder.pubkey()), 100_000_000_000_000);
        let wbordr: bordrless_token::state::Mint = w.env.read(&WBORDR);
        assert!(wbordr.hook_program.is_none(), "wBORDR is plain");

        // The pair's launch.
        let k = keeper();
        let launcher = w.env.funded(100 * SOL);
        let mint_kp = Keypair::new();
        let mint = mint_kp.pubkey();
        let create = CreateArgs {
            split: Split {
                buyback_bps: 0,
                holders_bps: 0,
                beneficiary_bps: 10_000,
            },
            bounty_bps: 50,
            max_buyback: SOL,
            buyback_interval: 60,
            vest_secs: 0,
            fund: SOL / 2,
        };
        let terms = CreateScriptArgs {
            // keeper.json's launcherShareBps: the launcher's creator fee, the rest the pot's.
            split: Split {
                buyback_bps: 0,
                holders_bps: 0,
                beneficiary_bps: k.launcher_share_bps,
            },
            pot_bps: 10_000 - k.launcher_share_bps,
            program: script::ID,
            interval: k.step_secs,
            state_len: k.state_len,
            init_data: vec![],
        };
        w.env
            .send_paid_by(
                &[
                    companion::create(launcher.pubkey(), launcher.pubkey(), mint, create),
                    companion::create_script(launcher.pubkey(), mint, terms, vec![]),
                    prepare_ix(launcher.pubkey(), mint),
                ],
                &launcher,
                &[&mint_kp],
            )
            .ok();
        let config_kp = Keypair::new();
        w.env
            .send_paid_by(
                &[launch::create_quote_cut_config(
                    launcher.pubkey(),
                    config_kp.pubkey(),
                    CreateConfigArgs {
                        rules: LaunchRules::NONE,
                        creator_fee_bps: CREATOR_FEE_BPS,
                        custom_hook: Some(hook::ID),
                        custom_hook_flags: FLAGS,
                        label: "BORDR Pair".to_string(),
                    },
                    0,
                    CUT,
                )],
                &launcher,
                &[&config_kp],
            )
            .ok();
        let args = World::launch_args("BPAIR", CREATOR_FEE_BPS, VQ, LaunchRules::NONE);
        let custom = w.custom_hook_accounts(&hook::ID, &mint);
        let inner = launch::create_launch_with(
            companion::creator_address(&mint),
            mint,
            w.env.treasury.pubkey(),
            w.sol,
            policy::LP_FEE_BPS,
            args.clone(),
            Some(config_kp.pubkey()),
            Some(&custom),
        );
        let ix = companion::launch_script(launcher.pubkey(), mint, &inner, args);
        w.env.send_paid_by(&[ix], &launcher, &[&mint_kp]).ok();
        let cranker = w.env.funded(10 * SOL);
        Self {
            w,
            mint,
            launcher,
            author,
            cranker,
            bordr_holder,
            some_holder: Pubkey::default(),
        }
    }

    fn keys(&self) -> LaunchKeys {
        LaunchKeys::of(&self.w.launch(&self.mint))
    }

    fn creator(&self) -> Pubkey {
        companion::creator_address(&self.mint)
    }

    fn state(&self) -> PairState {
        self.w.env.read(&companion::script_state_address(&self.mint))
    }

    fn dip_state(&self) -> hook::DipState {
        self.w.env.read(&hook::state_address(&self.mint))
    }

    fn companion(&self) -> Companion {
        self.w.env.read(&companion::companion_address(&self.mint))
    }

    fn cut(&self) -> u64 {
        self.w.launch(&self.mint).quote_cut_accrued()
    }

    fn hook_data(&self, owner: &Pubkey) -> [u8; 64] {
        self.w
            .env
            .read::<Holding>(&token::holding_address(&self.mint, owner))
            .hook_data
    }

    /// A fresh wallet's native buy of `lamports` (with the SOL cut's accounts).
    fn buy_new(&mut self, lamports: u64) -> (Keypair, Tx) {
        let t = self.w.env.funded(lamports + SOL);
        let tx = self.buy(&t, lamports);
        (t, tx)
    }

    fn buy(&mut self, t: &Keypair, lamports: u64) -> Tx {
        let tp = t.pubkey();
        let slice = self.w.launch_base_slice(&self.mint, &tp, &tp, true);
        let ix = launch::swap_v2_with_base_slice(&self.keys(), tp, tp, 1, lamports, 0, slice);
        let ix = self.w.with_quote_cut(ix, &self.mint, &tp);
        let mint = self.mint;
        if self.some_holder == Pubkey::default() {
            self.some_holder = token::holding_address(&mint, &tp);
        }
        self.w
            .env
            .send_paid_by(&[token::create_holding(tp, mint, tp), ix], t, &[])
    }

    fn sell(&mut self, t: &Keypair, amount: u64) -> Tx {
        let tp = t.pubkey();
        let slice = self.w.launch_base_slice(&self.mint, &tp, &tp, false);
        let ix = launch::swap_v2_with_base_slice(&self.keys(), tp, tp, 0, amount, 0, slice);
        let ix = self.w.with_quote_cut(ix, &self.mint, &tp);
        self.w.env.send_paid_by(&[ix], t, &[])
    }

    /// The fees into the pot (and the launcher's and the author's parts out).
    /// (A claim with nothing to claim fails with the companion's `NothingToDo`: callers that only
    /// top the pot up ignore it.)
    fn claim(&mut self) -> Tx {
        let c = self.cranker.insecure_clone();
        let ix = companion::claim_fees_script(c.pubkey(), self.mint, Some(self.author.pubkey()));
        self.w.env.send_paid_by(&[ix], &c, &[])
    }

    /// The step's accounts after the six, as Bordrless's keeper builds them from keeper.json:
    /// the launch pool's swap accounts (the coin's hook slice in them carries the
    /// launch pool's LP mint and the launch's LP holding, from the hook's registry) and its quote
    /// vault; then for each pool in keeper.json's order (coin/wBORDR
    /// with liquidity, then wBORDR/SOL) its classic swap's accounts for the companion address (the
    /// pool, both mints, both vaults, the companion address's holdings of both, the DEX's fixed
    /// accounts), the system program and the DEX, each mint's token-hook accounts, and with
    /// liquidity its LP mint and the launch's and the companion address's LP holdings; then the
    /// holdings keeper.json asks for; the mint made writable (`mintWritable`).
    fn keeper_extra(&self) -> Vec<AccountMeta> {
        let creator = self.creator();
        let mint = self.mint;
        let k = self.keys();
        let slice = self.w.launch_base_slice(&mint, &creator, &creator, true);
        let launch_swap = launch::swap_v2_with_base_slice(&k, creator, creator, 1, 0, 0, slice.clone());
        let mut extra = metas(&launch_swap);
        // The launch pool's quote vault, which Bordrless's keeper passes after the swap accounts
        // (LiquidityTek's steps, account 46): what an add to the launch pool takes.
        extra.push(rw(swap::vault_address(&k.pool(), &self.w.sol)));
        let launch_key = launch::launch_address(&mint);
        // keeper.json's pools, at their `feeBps`: coin/wBORDR (the script's tier), wBORDR/SOL
        // (Bordrless's pool's).
        let fees = keeper().pool_fees;
        assert_eq!(fees, [script::PAIR_LP_FEE_BPS, script::WBORDR_POOL_LP_FEE_BPS], "keeper.json's feeBps");
        let pools = [(mint, WBORDR, fees[0], true), (WBORDR, self.w.sol, fees[1], false)];
        for (base, quote, fee_bps, liquidity) in pools {
            let pool = swap::pool_address(&base, &quote, fee_bps, None);
            extra.extend([
                rw(pool),
                ro(base),
                ro(quote),
                rw(swap::vault_address(&pool, &base)),
                rw(swap::vault_address(&pool, &quote)),
                rw(token::holding_address(&base, &creator)),
                rw(token::holding_address(&quote, &creator)),
                // The DEX's fixed accounts (its config writable and its treasury: what creating a
                // pool takes beside a swap's).
                rw(swap::config_address()),
                rw(self.w.env.treasury.pubkey()),
                ro(bordrless_token::ID),
                ro(token::event_authority()),
                ro(swap::event_authority()),
                ro(SYSTEM_PROGRAM_ID),
                ro(bordrless_swap::ID),
            ]);
            for m in [base, quote] {
                if m == mint {
                    extra.extend(slice.iter().cloned());
                }
            }
            if liquidity {
                let lp = swap::lp_mint_address(&pool);
                extra.extend([
                    rw(lp),
                    rw(token::holding_address(&lp, &launch_key)),
                    rw(token::holding_address(&lp, &creator)),
                ]);
            }
        }
        if self.some_holder != Pubkey::default() {
            extra.push(ro(self.some_holder));
        }
        assert!(!keeper().mint_writable, "nothing is burned: no writable mint asked for");
        extra
    }

    fn step_ix(&self, extra: Vec<AccountMeta>) -> Instruction {
        companion::script_step(self.cranker.pubkey(), &self.keys(), script::ID, extra)
    }

    /// A step, a stepSecs after the last, as the keeper sends it.
    fn step(&mut self) -> Tx {
        self.step_with(self.keeper_extra())
    }

    fn step_with(&mut self, extra: Vec<AccountMeta>) -> Tx {
        self.w.env.warp(keeper().step_secs);
        let ix = self.step_ix(extra);
        let c = self.cranker.insecure_clone();
        self.w.env.send_paid_by(&[ix], &c, &[])
    }

    /// Fills the curve with native buys and graduates it.
    fn graduate(&mut self) -> Tx {
        loop {
            let l = self.w.launch(&self.mint);
            let p = self.w.launch_pool(&self.mint);
            if p.quote_reserve >= l.graduation_quote || p.base_reserve == 0 {
                break;
            }
            let missing = l.graduation_quote - p.quote_reserve;
            let (_, tx) = self.buy_new((missing + missing / 20).min(20 * SOL).max(SOL / 10));
            tx.ok();
        }
        let c = self.cranker.insecure_clone();
        let ix = self.w.graduate_ix(&c.pubkey(), &self.mint);
        let tx = self.w.env.send_paid_by(&[ix], &c, &[]);
        tx.ok();
        assert_eq!(self.w.launch(&self.mint).status, STATUS_GRADUATED);
        tx
    }

    /// Bordrless's live wBORDR/SOL pool, cloned from mainnet: the pool, its two vaults, its LP mint
    /// and wBORDR's mint (the bridge's, at the address the local bridge registered it).
    fn clone_live_wbordr_pool(&mut self) -> bordrless_swap::state::Pool {
        let pool = mainnet_account(&WBORDR_POOL);
        let p: bordrless_swap::state::Pool = AccountDeserialize::try_deserialize(&mut &pool.data[..]).unwrap();
        assert_eq!((p.base_mint, p.quote_mint, p.lp_fee_bps, p.hook_program), (WBORDR, self.w.sol, 30, None));
        assert!(p.quote_native() && !p.curve);
        for key in [WBORDR_POOL, p.base_vault, p.quote_vault, p.lp_mint, WBORDR] {
            self.w.env.put(key, mainnet_account(&key));
        }
        assert_eq!(swap::vault_address(&WBORDR_POOL, &WBORDR), p.base_vault);
        assert_eq!(self.w.env.holding(&WBORDR, &WBORDR_POOL), p.base_reserve, "the vault holds the reserve");
        p
    }

    fn pair_pool(&self) -> Pubkey {
        swap::pool_address(&self.mint, &WBORDR, script::PAIR_LP_FEE_BPS, None)
    }

    fn lp_mint(&self) -> Pubkey {
        swap::lp_mint_address(&self.pair_pool())
    }

    fn locked_lp(&self) -> u64 {
        self.w
            .env
            .holding(&self.lp_mint(), &launch::launch_address(&self.mint))
    }

    /// The launch's holding of the launch pool's LP (its locked LP).
    fn launch_pool_lp(&self) -> u64 {
        let lp = swap::lp_mint_address(&self.keys().pool());
        self.w.env.holding(&lp, &launch::launch_address(&self.mint))
    }

    /// Fills the pot: four wallets trade, then a claim.
    fn fill_pot(&mut self, sol: u64) {
        for _ in 0..4 {
            let (t, tx) = self.buy_new(sol);
            tx.ok();
            let held = self.w.env.holding(&self.mint, &t.pubkey());
            self.sell(&t, held / 2).ok();
        }
        self.claim();
    }

    /// Steps until one does `action` (at most `n`; idle ones skipped, as the keeper's simulation
    /// skips them); answers (action, lamports spent, CU) of the steps that went through.
    fn step_until(&mut self, action: u8, n: usize) -> Vec<(u8, u64, u64)> {
        let mut log = vec![];
        for _ in 0..n {
            let tx = self.step();
            if tx.result.is_err() {
                assert!(tx.logs().iter().any(|l| l.contains("idle:")), "only idle steps fail:\n{}", tx.logs().join("\n"));
                continue;
            }
            let ev = stepped(&tx);
            let st = self.state();
            log.push((st.last_action, ev.sol_before.saturating_sub(ev.sol_after), tx.cu()));
            if st.last_action == action {
                return log;
            }
        }
        panic!("no action {action} in {n} steps: {log:?} {:?}", self.state());
    }

    /// Lets the hook's six-hour reference settle at the price: six hours, then a small buy, then
    /// six hours and another.
    fn settle(&mut self) {
        for _ in 0..2 {
            self.w.env.warp(hook::REFERENCE_SECS);
            let (_, tx) = self.buy_new(SOL / 100);
            tx.ok();
        }
        self.w.env.warp(5);
    }
}

/// A dip after graduation: three whales buy, the reference settles, they sell everything.
fn make_dip(p: &mut Pair) {
    let mint = p.mint;
    let mut whales = vec![];
    for _ in 0..3 {
        let (wh, tx) = p.buy_new(10 * SOL);
        tx.ok();
        whales.push(wh);
    }
    p.settle();
    for wh in &whales {
        let held = p.w.env.holding(&mint, &wh.pubkey());
        p.sell(wh, held).ok();
    }
    assert!(p.dip_state().dip, "a dip");
}

/// A step that had nothing to do: it failed (the keeper's simulation never sends it), with its
/// reason logged.
#[track_caller]
fn idle(tx: &Tx, reason: &str) {
    tx.expect_fail();
    assert!(
        tx.logs().iter().any(|l| l.contains(&format!("idle: {reason}"))),
        "expected idle: {reason}\n{}",
        tx.logs().join("\n")
    );
}

/// The checks a step must pass: what the companion checks after it held (the step went through),
/// within the call depth (5) and the instruction trace (64); the dev bag (none here) kept.
#[track_caller]
fn stepped(tx: &Tx) -> ScriptStepped {
    tx.ok();
    assert!(tx.max_height() <= 5, "call depth {}", tx.max_height());
    assert!(tx.trace_len() <= 64, "trace {}", tx.trace_len());
    tx.event()
}

/// The held coin's records and the pot, read together.
fn pot(p: &Pair) -> u64 {
    p.companion().pending_pot
}

#[test]
fn pair_end_to_end() {
    let mut p = Pair::launched();
    let mint = p.mint;
    let l = p.w.launch(&mint);
    assert_eq!(l.custom_hook, Some(hook::ID));
    assert_eq!(l.custom_hook_flags, FLAGS);
    assert!(l.is_native(), "launched native");
    assert_eq!(l.quote_cut().map(|(h, c)| (h, c.max_buy_bps, c.max_sell_bps)), Some((hook::ID, 100, 300)));
    assert_eq!(p.companion().pot_bps, 6_000, "launcherShareBps 4,000: 60% to the pot");
    let st = p.state();
    assert_eq!((st.version, st.mint), (1, mint));
    // The hook's registry carries the launch pool's LP mint and the launch's LP holding.
    let reg = p.w.env.account(&bordrless_hook::hook_accounts_address(&hook::ID, &mint).0).unwrap();
    let list = bordrless_hook::HookAccountList::decode(&reg.data).unwrap();
    let lp_mint = swap::lp_mint_address(&p.keys().pool());
    let lp_holding = token::holding_address(&lp_mint, &launch::launch_address(&mint));
    assert_eq!(hook::launch_lp_accounts(&mint), (lp_mint, lp_holding));
    assert_eq!(list.accounts.len(), 3);
    assert_eq!((list.accounts[1].writable, &list.accounts[1].source), (true, &bordrless_hook::AccountSource::Key(lp_mint)));
    assert_eq!((list.accounts[2].writable, &list.accounts[2].source), (true, &bordrless_hook::AccountSource::Key(lp_holding)));

    // --- An empty pot after the sniper window: idle, not sent.
    p.w.env.warp(31);
    idle(&p.step(), script::idle::PREGRAD_CAP);

    // --- Trades on the curve: the SOL cut, no hook data, holdings close.
    let cut0 = p.cut();
    let (a, tx) = p.buy_new(2 * SOL);
    tx.ok();
    assert_eq!(p.cut() - cut0, 2 * SOL / 100, "a buy pays 1% of its SOL");
    assert_eq!(p.hook_data(&a.pubkey()), [0u8; 64], "no hook data");
    let held = p.w.env.holding(&mint, &a.pubkey());
    let cut1 = p.cut();
    let sol0 = p.w.env.lamports(&a.pubkey());
    p.sell(&a, held).ok();
    let got = p.w.env.lamports(&a.pubkey()) - sol0;
    let taken = p.cut() - cut1;
    let whole = got + taken;
    assert!(taken * 100 >= whole && taken * 100 <= whole * 105 / 100, "1% of a sell: {taken} of {whole}");
    let close = token::close_holding(a.pubkey(), mint, token::holding_address(&mint, &a.pubkey()), a.pubkey());
    p.w.env.send_paid_by(&[close], &a, &[]).ok();
    assert!(p.w.env.account(&token::holding_address(&mint, &a.pubkey())).is_none(), "the holding closed");

    // --- The pot buys and holds: first a step that sets the reference, then a buy of 1% of the
    // curve's depth at most, all of it into the buy, no SOL cut on it.
    p.fill_pot(SOL);
    let tx = p.step();
    stepped(&tx);
    assert_eq!(p.state().last_action, action::OBSERVE);
    let depth = {
        let c = p.w.launch_pool(&mint);
        u128::from(c.quote_reserve) + u128::from(c.virtual_quote)
    };
    let (cut2, pot0) = (p.cut(), pot(&p));
    let tx = p.step();
    let ev = stepped(&tx);
    let st = p.state();
    assert_eq!(st.last_action, action::HOLD);
    let spend = ev.sol_before - ev.sol_after;
    assert!(spend > 0 && u128::from(spend) * 100 <= depth, "at most 1% of the curve's depth");
    assert!(u128::from(spend) <= u128::from(pot0 - script::POT_FLOOR_LAMPORTS) / 2);
    assert_eq!(st.coin_hold, ev.tokens_after - ev.tokens_before, "held");
    assert_eq!(st.pregrad_spent, spend);
    assert_eq!(p.cut(), cut2, "the companion address's buy pays no SOL cut");
    println!("hold: spent {spend}, {} CU", tx.cu());

    // --- A pump: the next buy waits (the step is idle, not sent; the pot untouched).
    let (_, tx) = p.buy_new(8 * SOL);
    tx.ok();
    let pot1 = pot(&p);
    idle(&p.step(), script::idle::PRICE_ABOVE_REFERENCE);
    assert_eq!(pot(&p), pot1);

    // --- A dip on the curve: seen once (kept), bought for the liquidity on the next step.
    let (whale, tx) = p.buy_new(10 * SOL);
    tx.ok();
    p.settle();
    let held = p.w.env.holding(&mint, &whale.pubkey());
    p.sell(&whale, held).ok();
    assert!(p.dip_state().dip, "a dip");
    p.claim();
    let tx = p.step();
    stepped(&tx);
    assert_eq!((p.state().last_action, p.state().dip_streak), (action::OBSERVE, 1), "a dip's first sighting");
    let supply0 = p.w.env.read::<bordrless_token::state::Mint>(&mint).supply;
    let hold0 = p.state().coin_hold;
    let tx = p.step();
    let ev = stepped(&tx);
    let st = p.state();
    assert_eq!(st.last_action, action::DIP_BUY, "held two observations: bought");
    let bought = ev.tokens_after - ev.tokens_before;
    assert!(bought > 0 && bought == st.dip_bought);
    assert_eq!(st.coin_hold, hold0 + bought, "held for the liquidity");
    assert_eq!(p.w.env.read::<bordrless_token::state::Mint>(&mint).supply, supply0, "nothing burned");
    println!("curve dip buy: spent {}, bought {bought}, {} CU", ev.sol_before - ev.sol_after, tx.cu());
    p.settle();

    // --- More holds, then graduation.
    p.fill_pot(SOL);
    p.step_until(action::HOLD, 300);
    let st = p.state();
    assert!(st.pregrad_spent <= script::step::pregrad_room(pot(&p), 0).max(st.pregrad_spent) && u128::from(st.pregrad_spent) * 2 <= u128::from(pot(&p)) + u128::from(st.pregrad_spent) + u128::from(script::MIN_SPEND_LAMPORTS), "at most half the pot before graduation");
    let hold = st.coin_hold;
    let pregrad = st.pregrad_spent;
    assert!(hold > 0);
    p.graduate();
    // The claim pays the builder's share (the approval names the author): half of the launcher's
    // part of the creator fee, never the pot's.
    let author0 = p.w.env.lamports(&p.author.pubkey());
    p.claim().ok();
    assert!(p.w.env.lamports(&p.author.pubkey()) > author0, "the builder share is paid");
    let lp0 = p.launch_pool_lp();

    // --- After graduation: the held coin, half to the launch pool with pot SOL (the LP straight
    // into the launch's holding), half kept for coin/wBORDR.
    let log = p.step_until(action::ADD_SOL_POOL, 400);
    println!("after graduation (action, spent, CU): {log:?}");
    assert_eq!(log.len(), 2, "one observe at the graduated price, then the add");
    let st = p.state();
    assert_eq!(st.coin_hold, 0);
    assert_eq!(st.coin_for_pair, hold - hold / 2, "half for the pair");
    assert!(st.coin_for_sol < hold / 2, "the launch pool's half (or most of it) added");
    assert_eq!(p.launch_pool_lp() - lp0, st.sol_pool_lp_locked);
    assert!(st.sol_pool_lp_locked > 0);
    assert!(st.sol_leg >= pregrad / 2 && st.pair_leg == pregrad - pregrad / 2);
    assert_eq!(p.w.env.holding(&lp_mint, &p.creator()), 0, "no LP with the companion address");
    assert_eq!(p.w.env.holding(&p.w.sol, &p.creator()), 0, "no SOL left wrapped");

    // --- The wBORDR/SOL pool absent: the pair's half is kept, and the pot goes on to the launch
    // pool rather than waiting.
    let mut absent = false;
    for _ in 0..400 {
        p.claim();
        let before = p.state();
        let tx = p.step();
        if tx.result.is_err() {
            continue;
        }
        stepped(&tx);
        let st = p.state();
        if tx.logs().iter().any(|l| l.contains("pair blocked (no wBORDR/SOL pool)")) {
            assert_eq!(st.last_action, action::BUY_COIN);
            assert!(st.sol_leg > before.sol_leg && st.coin_for_sol > before.coin_for_sol, "for the launch pool");
            assert_eq!(st.coin_for_pair, before.coin_for_pair, "the pair's half kept");
            absent = true;
            break;
        }
    }
    assert!(absent, "the launch pool's side goes on without the wBORDR/SOL pool");

    // --- Bordrless's live wBORDR/SOL pool: wBORDR bought, coin/wBORDR created, its LP locked
    // (with fees from new trading: the launch pool's side took the pot meanwhile).
    p.clone_live_wbordr_pool();
    p.fill_pot(SOL);
    let log = p.step_until(action::CREATE_PAIR, 400);
    println!("pair (action, spent, CU): {log:?}");
    let st = p.state();
    let pool = p.w.env.read::<bordrless_swap::state::Pool>(&p.pair_pool());
    assert_eq!((pool.base_mint, pool.quote_mint, pool.lp_fee_bps), (mint, WBORDR, script::PAIR_LP_FEE_BPS));
    assert!(p.locked_lp() > 0 && p.locked_lp() == st.pair_lp_locked);
    assert_eq!(p.w.env.holding(&p.lp_mint(), &p.creator()), 0);

    // --- Then 50/50: the legs grow alike, the coin/wBORDR pool added to.
    let mut added = false;
    for _ in 0..300 {
        p.claim();
        let before = p.state();
        let tx = p.step();
        if tx.result.is_err() {
            continue;
        }
        stepped(&tx);
        let st = p.state();
        added |= st.last_action == action::ADD_PAIR;
        // 50/50: no new coin is bought for the launch pool while it is ahead of the pair.
        if before.sol_leg > before.pair_leg && st.last_action == action::BUY_COIN {
            assert_eq!(st.sol_leg, before.sol_leg, "a coin buy for the leg that is ahead");
        }
    }
    let st = p.state();
    println!("legs: SOL pool {} lamports, coin/wBORDR {} lamports; LP locked {} / {}", st.sol_leg, st.pair_leg, st.sol_pool_lp_locked, st.pair_lp_locked);
    assert!(added, "an add to coin/wBORDR");
    assert!(st.sol_leg > 0 && st.pair_leg > 0, "both pools funded");
    assert_eq!(p.w.env.lamports(&BUILDER), 0, "the script pays no one: the pot goes into the liquidity");

    // --- Both LPs are locked: nobody can withdraw them.
    let attacker = p.w.env.funded(SOL);
    let launch_key = launch::launch_address(&mint);
    for lp in [p.lp_mint(), lp_mint] {
        let steal = token::transfer(
            attacker.pubkey(),
            token::holding_address(&lp, &launch_key),
            token::holding_address(&lp, &attacker.pubkey()),
            lp,
            None,
            vec![],
            1,
        );
        p.w.env
            .send_paid_by(&[token::create_holding(attacker.pubkey(), lp, attacker.pubkey()), steal], &attacker, &[])
            .expect_fail();
    }
    let mut remove = swap::remove_liquidity(
        &swap::LiquidityKeys { provider: launch_key, pool: p.pair_pool(), base_mint: mint, quote_mint: WBORDR, hook_program: None },
        bordrless_swap::instructions::RemoveLiquidityArgs { lp_amount: 1, min_base: 0, min_quote: 0, base_hook_accounts: 0, quote_hook_accounts: 0, hook_data: vec![] },
        vec![],
    );
    remove.accounts[0].is_signer = false;
    p.w.env.send_paid_by(&[remove], &attacker, &[]).expect_fail();
    assert_eq!(p.locked_lp(), p.state().pair_lp_locked);

    // --- Custody held throughout.
    let creator = p.w.env.account(&p.creator()).unwrap();
    assert_eq!(creator.owner, SYSTEM_PROGRAM_ID);
    assert!(creator.data.is_empty());
    assert!(creator.lamports >= p.w.env.rent(0) + p.companion().set_aside().unwrap());
    let _ = (&p.launcher, &p.author);
}

/// Before graduation: nothing within the sniper window (here a longer one than the 60 s floor),
/// then holds of at most 1% of the curve each, until half the pot is spent.
#[test]
fn holds_on_the_curve_skip_the_sniper_window_and_stop_at_half_the_pot() {
    let mut p = Pair::launched();
    let key = launch::launch_address(&p.mint);
    let mut account = p.w.env.account(&key).unwrap();
    let mut l = bordrless_launch::state::Launch::try_deserialize(&mut &account.data[..]).unwrap();
    l.sniper_window_secs = 600;
    let mut data = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&l, &mut data).unwrap();
    account.data[..data.len()].copy_from_slice(&data);
    p.w.env.put(key, account);
    assert_eq!(script::step::curve_opens_at(&p.w.launch(&p.mint)), l.created_at + 600);
    // Inside the window: idle, whatever the pot.
    p.w.env.warp(60);
    idle(&p.step(), script::idle::SNIPER);
    p.w.env.warp(600);
    p.fill_pot(2 * SOL);
    let pot0 = pot(&p);
    let mut holds = 0;
    let mut spent = 0u64;
    let mut capped = false;
    for _ in 0..600 {
        let depth = {
            let c = p.w.launch_pool(&p.mint);
            u128::from(c.quote_reserve) + u128::from(c.virtual_quote)
        };
        let tx = p.step();
        if tx.result.is_err() {
            if tx.logs().iter().any(|l| l.contains("idle: pre-graduation cap")) {
                capped = true;
                break;
            }
            continue;
        }
        let ev = stepped(&tx);
        if p.state().last_action == action::HOLD {
            let s = ev.sol_before - ev.sol_after;
            assert!(u128::from(s) * 100 <= depth, "1% of the curve's depth");
            holds += 1;
            spent += s;
        }
    }
    let st = p.state();
    println!("holds: {holds}, spent {spent} of a pot of {pot0}; left {}", pot(&p));
    assert!(capped, "the cap: {st:?}");
    assert_eq!(st.pregrad_spent, spent);
    assert!(u128::from(spent) * 2 <= u128::from(pot0) + u128::from(script::MIN_SPEND_LAMPORTS), "at most half the pot");
    assert!(pot(&p) >= pot0 - spent - 60 * SCRIPT_BOUNTY, "the rest stays in the pot");
}

/// A pair through the creation of its coin/wBORDR pool, on the live wBORDR/SOL pool.
fn ready_pair() -> Pair {
    let mut p = Pair::launched();
    p.w.env.warp(31);
    p.fill_pot(SOL);
    p.step_until(action::HOLD, 5);
    p.graduate();
    p.claim();
    p.clone_live_wbordr_pool();
    p.step_until(action::CREATE_PAIR, 600);
    p
}

/// A classic swap of `amount_in` on the coin/wBORDR pool by `h` (`direction` 1 buys the coin with
/// wBORDR, 0 sells it).
fn pair_swap(p: &mut Pair, h: &Keypair, direction: u8, amount_in: u64) -> Tx {
    let pool = p.pair_pool();
    let slice = p.w.env.token_hook_slice(
        &p.mint,
        &swap::vault_address(&pool, &p.mint),
        &token::holding_address(&p.mint, &h.pubkey()),
        &pool,
        &pool,
        &h.pubkey(),
    );
    let n = u8::try_from(slice.len()).unwrap();
    let ix = swap::swap(
        &swap::SwapKeys {
            trader: h.pubkey(),
            pool,
            base_mint: p.mint,
            quote_mint: WBORDR,
            trader_base: token::holding_address(&p.mint, &h.pubkey()),
            trader_quote: token::holding_address(&WBORDR, &h.pubkey()),
            hook_program: None,
            base_mint_writable: false,
            quote_mint_writable: false,
        },
        bordrless_swap::instructions::SwapArgs {
            direction,
            amount_in,
            min_amount_out: 0,
            in_hook_accounts: if direction == 0 { n } else { 0 },
            out_hook_accounts: if direction == 0 { 0 } else { n },
            hook_data: vec![],
        },
        slice,
    );
    let mint = p.mint;
    p.w.env
        .send_paid_by(&[token::create_holding(h.pubkey(), mint, h.pubkey()), ix], h, &[])
}

/// The pair pool's price against the one the two SOL pools imply.
fn pair_vs_implied(p: &Pair) -> (u128, u128) {
    let pair = p.w.env.read::<bordrless_swap::state::Pool>(&p.pair_pool());
    let wpool = p.w.env.read::<bordrless_swap::state::Pool>(&WBORDR_POOL);
    let lpool = p.w.launch_pool(&p.mint);
    let implied = script::step::implied_price(
        hook::price(lpool.base_reserve, lpool.virtual_base, lpool.quote_reserve, lpool.virtual_quote),
        hook::price(wpool.base_reserve, 0, wpool.quote_reserve, 0),
    )
    .unwrap();
    (hook::price(pair.base_reserve, 0, pair.quote_reserve, 0), implied)
}

/// The pair pool strays (someone trades it away from the SOL pools' price): no add while it does;
/// the script trades it back with what it holds (buying the cheap coin), then adds again.
#[test]
fn a_strayed_pair_pool_is_healed_then_added_to() {
    let mut p = ready_pair();
    let h = p.bordr_holder.insecure_clone();
    let reserve = p.w.env.read::<bordrless_swap::state::Pool>(&p.pair_pool()).quote_reserve;
    // wBORDR in, the coin out: the coin dear in the pair pool.
    pair_swap(&mut p, &h, 1, reserve / 5).ok();
    let (price, implied) = pair_vs_implied(&p);
    assert!(script::step::strays(price, implied), "strayed");
    let mut healed = false;
    for _ in 0..400 {
        p.claim();
        let tx = p.step();
        if tx.result.is_err() {
            continue;
        }
        stepped(&tx);
        let st = p.state();
        if !healed {
            assert_ne!(st.last_action, action::ADD_PAIR, "no add while the pair pool strays");
            healed = st.last_action == action::HEAL_PAIR;
            if healed {
                let (price, implied) = pair_vs_implied(&p);
                assert!(!script::step::strays(price, implied), "healed to within the guard");
            }
        } else if st.last_action == action::ADD_PAIR {
            return;
        }
    }
    panic!("healed {healed}, then no add: {:?}", p.state());
}

/// Someone makes the coin/wBORDR pool first, with dust, at three times the implied price: the
/// script heals it (the squatter's dust buys the pot cheap wBORDR), adds, and locks the LP.
#[test]
fn a_squatted_pair_pool_is_healed_and_used() {
    let mut p = Pair::launched();
    p.w.env.warp(31);
    p.fill_pot(SOL);
    p.step_until(action::HOLD, 5);
    p.graduate();
    p.claim();
    p.clone_live_wbordr_pool();
    // The squatter: some coin from the launch pool, wBORDR from the BORDR holder.
    let (sq, tx) = p.buy_new(SOL / 10);
    tx.ok();
    let h = p.bordr_holder.insecure_clone();
    let sqk = sq.pubkey();
    p.w.env
        .send_paid_by(
            &[
                token::create_holding(h.pubkey(), WBORDR, sqk),
                token::transfer_with(h.pubkey(), token::holding_address(&WBORDR, &h.pubkey()), token::holding_address(&WBORDR, &sqk), WBORDR, None, vec![], 1_000_000_000_000),
            ],
            &h,
            &[],
        )
        .ok();
    let wpool = p.w.env.read::<bordrless_swap::state::Pool>(&WBORDR_POOL);
    let lpool = p.w.launch_pool(&p.mint);
    let implied = script::step::implied_price(
        hook::price(lpool.base_reserve, lpool.virtual_base, lpool.quote_reserve, lpool.virtual_quote),
        hook::price(wpool.base_reserve, 0, wpool.quote_reserve, 0),
    )
    .unwrap();
    let base = 1_000_000_000u64;
    let quote = u64::try_from(script::step::value(base, implied) * 3).unwrap();
    let slice = p.w.launch_base_slice(&p.mint, &sqk, &sqk, false);
    let treasury = p.w.env.treasury.pubkey();
    let create = swap::create_pool(
        &swap::CreatePoolKeys { payer: sqk, authority: sqk, treasury, base_mint: p.mint, quote_mint: WBORDR, hook_caller: None },
        bordrless_swap::instructions::CreatePoolArgs {
            lp_fee_bps: script::PAIR_LP_FEE_BPS,
            hook_program: Pubkey::default(),
            hook_flags: 0,
            virtual_base: 0,
            virtual_quote: 0,
            base_amount: base,
            quote_amount: quote,
            base_hook_accounts: u8::try_from(slice.len()).unwrap(),
            quote_hook_accounts: 0,
            hook_data: vec![],
        },
        slice,
    );
    p.w.env.send_paid_by(&[create], &sq, &[]).ok();
    let (price, implied) = pair_vs_implied(&p);
    assert!(script::step::strays(price, implied), "squatted at another price");
    let log = p.step_until(action::HEAL_PAIR, 600);
    println!("to the heal: {log:?}");
    let (price, implied) = pair_vs_implied(&p);
    assert!(!script::step::strays(price, implied), "healed");
    p.step_until(action::ADD_PAIR, 400);
    assert!(p.locked_lp() > 0 && p.locked_lp() == p.state().pair_lp_locked, "the LP locked");
}

/// A step built short of what keeper.json asks for fails (no bounty, the interval left whole, so
/// the keeper's own step goes through right after); one without the DEX's config writable (what
/// only creating the coin/wBORDR pool needs) is idle instead.
#[test]
fn steps_built_short_fail_and_leave_the_interval() {
    let mut p = Pair::launched();
    p.w.env.warp(31);
    p.fill_pot(SOL);
    p.step_until(action::HOLD, 5);
    let short = |tx: &Tx| {
        tx.expect_fail();
        assert!(tx.logs().iter().any(|l| l.contains("MissingAccount")), "{}", tx.logs().join("\n"));
    };
    short(&p.step_with(vec![]));
    let no_config: Vec<AccountMeta> = p.keeper_extra().into_iter().filter(|a| a.pubkey != swap::config_address()).collect();
    short(&p.step_with(no_config));
    // The keeper's step, with no further wait: the failed ones used up nothing.
    let ix = p.step_ix(p.keeper_extra());
    let c = p.cranker.insecure_clone();
    stepped(&p.w.env.send_paid_by(&[ix], &c, &[]));
    // After graduation, the wBORDR/SOL pool's key replaced.
    p.graduate();
    p.claim();
    p.clone_live_wbordr_pool();
    let fake = Pubkey::new_unique();
    let swapped: Vec<AccountMeta> = p
        .keeper_extra()
        .into_iter()
        .map(|mut a| {
            if a.pubkey == WBORDR_POOL {
                a.pubkey = fake;
            }
            a
        })
        .collect();
    let mut short_seen = false;
    for _ in 0..400 {
        let tx = p.step_with(swapped.clone());
        if tx.logs().iter().any(|l| l.contains("MissingAccount")) {
            short_seen = true;
            break;
        }
    }
    assert!(short_seen, "the wBORDR/SOL pool is asked for");
    // The DEX config read-only (a classic swap's): the buys go on, creating the pool waits, and
    // the pot goes on to the launch pool meanwhile.
    let ro_config: Vec<AccountMeta> = p
        .keeper_extra()
        .into_iter()
        .map(|mut a| {
            if a.pubkey == swap::config_address() {
                a.is_writable = false;
            }
            a
        })
        .collect();
    let mut blocked = false;
    for _ in 0..400 {
        p.claim();
        let tx = p.step_with(ro_config.clone());
        if tx.result.is_err() {
            continue;
        }
        stepped(&tx);
        let st = p.state();
        assert_ne!(st.last_action, action::CREATE_PAIR);
        if tx.logs().iter().any(|l| l.contains("pair blocked (dex config or treasury)")) {
            assert_eq!(st.last_action, action::BUY_COIN, "the pot goes on to the launch pool");
            blocked = true;
            break;
        }
    }
    assert!(blocked, "creating the pool needs the config writable: the launch pool's side goes on");
    // A dip after graduation: bought with the mint read-only (nothing is burned), its coin half to
    // each pool.
    make_dip(&mut p);
    p.claim();
    stepped(&p.step());
    assert_eq!(p.state().last_action, action::OBSERVE, "the dip seen");
    let before = p.state();
    let tx = p.step();
    let ev = stepped(&tx);
    let st = p.state();
    assert_eq!(st.last_action, action::DIP_BUY);
    let bought = ev.tokens_after - ev.tokens_before;
    assert_eq!(st.coin_for_sol - before.coin_for_sol, bought / 2, "half for the launch pool");
    assert_eq!(st.coin_for_pair - before.coin_for_pair, bought - bought / 2, "half for the pair");
}

/// The step fits one transaction with a per-coin lookup table (Bordrless's keeper makes one), and
/// not without one.
#[test]
fn a_step_fits_a_transaction_with_a_lookup_table() {
    let mut p = ready_pair();
    p.claim();
    p.w.env.warp(keeper().step_secs);
    let ix = p.step_ix(p.keeper_extra());
    let c = p.cranker.insecure_clone();
    let mut keys: Vec<Pubkey> = ix.accounts.iter().map(|a| a.pubkey).filter(|k| *k != c.pubkey()).collect();
    keys.push(ix.program_id);
    keys.sort();
    keys.dedup();
    let table = p.w.env.put_lookup_table(Pubkey::new_unique(), &keys);
    let ixs = [compute_unit_limit(1_400_000), ix];
    let with = p.w.env.v0_size(&ixs, &c, &[], std::slice::from_ref(&table));
    let without = p.w.env.v0_size(&ixs, &c, &[], &[]);
    println!("step: {} unique accounts; {with} bytes with the lookup table, {without} without", keys.len() + 1);
    assert!(with <= 1_232, "fits with the table: {with}");
    assert!(without > 1_232, "needs the table: {without}");
    let tx = p.w.env.send_v0(&ixs, &c, &[], std::slice::from_ref(&table));
    if tx.result.is_ok() {
        stepped(&tx);
    } else {
        assert!(tx.logs().iter().any(|l| l.contains("idle:")), "{}", tx.logs().join("\n"));
    }
    assert!(keys.len() < 128, "within the account locks");
}

/// The hook's SOL cut answers only the launchpad's signer; `prepare` runs once.
#[test]
fn the_hook_answers_only_its_callers() {
    let mut p = Pair::launched();
    let mint = p.mint;
    let fake = p.w.env.funded(SOL);
    let args = bordrless_hook::PoolHookArgs {
        op: bordrless_hook::PoolOp::Swap,
        phase: bordrless_hook::Phase::Before,
        pool: p.keys().pool(),
        base_mint: mint,
        quote_mint: p.w.sol,
        actor: fake.pubkey(),
        recipient: fake.pubkey(),
        direction: 1,
        amount_in: 1,
        amount_out: 0,
        base_reserve: 1,
        quote_reserve: 1,
        virtual_base: 1,
        virtual_quote: 1,
        lp_fee_bps: 0,
        protocol_fee_bps: 0,
        swap_count: 0,
        created_at: 0,
        lp_amount: 0,
        hook_data: vec![],
    };
    let mut ix = Instruction {
        program_id: hook::ID,
        accounts: hook::accounts::QuoteCut {
            signer: fake.pubkey(),
            launch: launch::launch_address(&mint),
            pool: p.keys().pool(),
            base_mint: mint,
            quote_mint: p.w.sol,
            actor: fake.pubkey(),
            holding: token::holding_address(&mint, &fake.pubkey()),
            state: hook::state_address(&mint),
        }
        .to_account_metas(Some(true)),
        data: hook::instruction::QuoteCut { args }.data(),
    };
    ix.accounts[0].is_signer = true;
    let tx = p.w.env.send_paid_by(&[ix], &fake, &[]);
    tx.expect_fail();
    assert!(tx.logs().iter().any(|l| l.contains("NotLaunchpad")), "{}", tx.logs().join("\n"));
    p.w.env.send_paid_by(&[prepare_ix(fake.pubkey(), mint)], &fake, &[]).expect_fail();
}

/// The layouts the script reads, against the programs' own; keeper.json's stateLen; the script's
/// DEX and bridge builders against the DEX's and the bridge's clients.
#[test]
fn the_layouts_the_script_reads_are_the_programs() {
    use anchor_lang::Discriminator;
    assert_eq!(script::layout::DIP_STATE_DISCRIMINATOR, hook::DipState::DISCRIMINATOR);
    assert_eq!(script::layout::COMPANION_DISCRIMINATOR, Companion::DISCRIMINATOR);
    assert_eq!(script::layout::POOL_DISCRIMINATOR, bordrless_swap::state::Pool::DISCRIMINATOR);
    assert_eq!(script::layout::DEX_CONFIG_DISCRIMINATOR, bordrless_swap::state::Config::DISCRIMINATOR);
    assert_eq!(keeper().state_len as usize, 8 + PairState::INIT_SPACE, "keeper.json stateLen");
    assert_eq!(hook::DIP_DEPTH_BPS, script::DIP_DEPTH_BPS);
    assert_eq!(hook::PRICE_SHIFT, script::PRICE_SHIFT);
    assert_eq!(hook::LAUNCH_LP_FEE_BPS, policy::LP_FEE_BPS);
    assert_eq!(hook::DEX_PROGRAM_ID, bordrless_swap::ID);
    assert_eq!(script::SWAP_PROGRAM, bordrless_swap::ID);
    assert_eq!(script::BRIDGE_PROGRAM, bordrless_bridge::ID);
    assert_eq!(script::COMPANION_PROGRAM, bordrless_companion::ID);
    assert_eq!(script::BRIDGED_SOL_MINT, bordrless_swap::constants::BRIDGED_SOL_MINT);
    assert_eq!(script::dex::SWAP_V2_DISCRIMINATOR, bordrless_swap::instruction::SwapV2::DISCRIMINATOR);
    assert_eq!(script::dex::SWAP_DISCRIMINATOR, bordrless_swap::instruction::Swap::DISCRIMINATOR);
    // The fixed keys the script keeps as constants rather than derive on every step.
    let wpool = swap::pool_address(&WBORDR, &script::BRIDGED_SOL_MINT, script::WBORDR_POOL_LP_FEE_BPS, None);
    assert_eq!(script::WBORDR_SOL_POOL, wpool);
    assert_eq!(script::WBORDR_SOL_POOL, WBORDR_POOL);
    assert_eq!(script::dex::WBORDR_SOL_VAULT, swap::vault_address(&wpool, &WBORDR));
    let bridge = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &bordrless_bridge::ID).0;
    assert_eq!(script::dex::BRIDGE_CONFIG, bridge(&[b"config"]));
    assert_eq!(script::dex::BRIDGE_SOL_WRAPPER, bridge(&[b"wrapper", script::dex::NATIVE_MINT.as_ref()]));
    assert_eq!(script::dex::BRIDGE_SOL_VAULT, bridge(&[b"sol-vault"]));
    assert_eq!(script::dex::BRIDGE_EVENT_AUTHORITY, bridge(&[b"__event_authority"]));
    assert_eq!(
        script::dex::LAUNCH_HOOK_SIGNER,
        Pubkey::find_program_address(&[b"hook-authority", bordrless_launch::ID.as_ref()], &bordrless_swap::ID).0
    );

    let mut p = ready_pair();
    let mint = p.mint;
    let raw = p.w.env.account(&hook::state_address(&mint)).unwrap().data;
    let st = p.dip_state();
    assert_eq!(&raw[10..42], st.mint.as_ref());
    assert_eq!(u128::from_le_bytes(raw[42..58].try_into().unwrap()), st.reference);
    assert_eq!(raw[82] == 1, st.dip);
    assert_eq!(i64::from_le_bytes(raw[83..91].try_into().unwrap()), st.dip_since);
    let raw = p.w.env.account(&companion::companion_address(&mint)).unwrap().data;
    let c = p.companion();
    let at = |o: usize| u64::from_le_bytes(raw[o..o + 8].try_into().unwrap());
    assert_eq!(at(script::layout::companion::PENDING_POT), c.pending_pot);
    assert_eq!(at(script::layout::companion::DEV_TOKENS), c.dev_tokens);
    assert_eq!(at(script::layout::companion::DEV_RELEASED), c.dev_released);
    let raw = p.w.env.account(&swap::config_address()).unwrap().data;
    let cfg: bordrless_swap::state::Config = p.w.env.read(&swap::config_address());
    assert_eq!(&raw[76..108], cfg.treasury.as_ref());
    assert_eq!(u64::from_le_bytes(raw[108..116].try_into().unwrap()), cfg.pool_creation_fee_lamports);
    assert_eq!(raw[116] != 0, cfg.paused);
    // The builders.
    let creator = p.creator();
    let ours = script::dex::swap_v2_buy(creator, token::holding_address(&WBORDR, &creator), 7, 3).unwrap();
    let theirs = swap::swap_v2(
        &swap::SwapV2Keys {
            trader: creator,
            pool: WBORDR_POOL,
            base_mint: WBORDR,
            trader_base: token::holding_address(&WBORDR, &creator),
            trader_quote: creator,
            hook_program: None,
            base_mint_writable: false,
            with_bridge: false,
        },
        bordrless_swap::instructions::SwapArgs { direction: 1, amount_in: 7, min_amount_out: 3, in_hook_accounts: 0, out_hook_accounts: 0, hook_data: vec![] },
        vec![],
    );
    assert_eq!(ours, theirs);
    let slice = p.w.launch_base_slice(&mint, &creator, &creator, false);
    let pair = p.pair_pool();
    for direction in [0u8, 1] {
        let n = u8::try_from(slice.len()).unwrap();
        let (cb, cq) = (token::holding_address(&mint, &creator), token::holding_address(&WBORDR, &creator));
        let ours = script::dex::swap(creator, pair, mint, WBORDR, cb, cq, direction, 7, 3, slice.clone()).unwrap();
        let theirs = swap::swap(
            &swap::SwapKeys {
                trader: creator,
                pool: pair,
                base_mint: mint,
                quote_mint: WBORDR,
                trader_base: token::holding_address(&mint, &creator),
                trader_quote: token::holding_address(&WBORDR, &creator),
                hook_program: None,
                base_mint_writable: false,
                quote_mint_writable: false,
            },
            bordrless_swap::instructions::SwapArgs {
                direction,
                amount_in: 7,
                min_amount_out: 3,
                in_hook_accounts: if direction == 0 { n } else { 0 },
                out_hook_accounts: if direction == 0 { 0 } else { n },
                hook_data: vec![],
            },
            slice.clone(),
        );
        assert_eq!(ours, theirs);
    }
    let treasury = p.w.env.treasury.pubkey();
    let creator_lp = token::holding_address(&swap::lp_mint_address(&pair), &creator);
    let ours = script::dex::create_pool(
        creator,
        treasury,
        mint,
        WBORDR,
        script::PAIR_LP_FEE_BPS,
        token::holding_address(&mint, &creator),
        token::holding_address(&WBORDR, &creator),
        creator_lp,
        5,
        6,
        slice.clone(),
    )
    .unwrap();
    let theirs = swap::create_pool(
        &swap::CreatePoolKeys { payer: creator, authority: creator, treasury, base_mint: mint, quote_mint: WBORDR, hook_caller: None },
        bordrless_swap::instructions::CreatePoolArgs {
            lp_fee_bps: script::PAIR_LP_FEE_BPS,
            hook_program: Pubkey::default(),
            hook_flags: 0,
            virtual_base: 0,
            virtual_quote: 0,
            base_amount: 5,
            quote_amount: 6,
            base_hook_accounts: u8::try_from(slice.len()).unwrap(),
            quote_hook_accounts: 0,
            hook_data: vec![],
        },
        slice.clone(),
    );
    assert_eq!(ours, theirs);
    // add_liquidity to the launch pool (its hook the launchpad), the LP to the launch's holding.
    let pool = p.keys().pool();
    let launch_lp = token::holding_address(&swap::lp_mint_address(&pool), &launch::launch_address(&mint));
    let ours = script::dex::add_liquidity(
        creator,
        pool,
        mint,
        p.w.sol,
        Some((bordrless_launch::ID, script::dex::LAUNCH_HOOK_SIGNER)),
        token::holding_address(&mint, &creator),
        token::holding_address(&p.w.sol, &creator),
        launch_lp,
        5,
        6,
        2,
        slice.clone(),
        launch::hook_extras(&mint, &p.w.sol),
    )
    .unwrap();
    let mut extras = slice.clone();
    extras.extend(launch::hook_extras(&mint, &p.w.sol));
    let mut theirs = swap::add_liquidity(
        &swap::LiquidityKeys { provider: creator, pool, base_mint: mint, quote_mint: p.w.sol, hook_program: Some(bordrless_launch::ID) },
        bordrless_swap::instructions::AddLiquidityArgs { base_desired: 5, quote_desired: 6, min_lp: 2, base_hook_accounts: u8::try_from(slice.len()).unwrap(), quote_hook_accounts: 0, hook_data: vec![] },
        extras,
    );
    theirs.accounts[10].pubkey = launch_lp;
    assert_eq!(ours, theirs);
    let wrapped = token::holding_address(&p.w.sol, &creator);
    assert_eq!(script::dex::bridge_sol(creator, wrapped, 9, false).unwrap(), bordrless_bridge::client::wrap_sol(creator, 9));
    assert_eq!(script::dex::bridge_sol(creator, wrapped, 9, true).unwrap(), bordrless_bridge::client::unwrap_sol(creator, 9));
    // The script's view of a pool.
    let info_data = p.w.env.account(&WBORDR_POOL).unwrap();
    let pool: bordrless_swap::state::Pool = bordrless_swap::state::Pool::try_deserialize(&mut &info_data.data[..]).unwrap();
    let mut data = info_data.data.clone();
    let mut lamports = info_data.lamports;
    let key = WBORDR_POOL;
    let owner = info_data.owner;
    let info = anchor_lang::prelude::AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
    let view = script::layout::PoolView::read(&info).expect("a pool");
    assert_eq!((view.base_reserve, view.quote_reserve, view.lp_supply, view.native()), (pool.base_reserve, pool.quote_reserve, pool.lp_supply, pool.quote_native()));
    let _ = &mut p;
}

/// The hook's rates and Dip Buy's arithmetic; the script's guards, budget and cap.
#[test]
fn the_hook_rates_and_reference() {
    assert_eq!(hook::rate_bps(true, false), 100);
    assert_eq!(hook::rate_bps(false, false), 100);
    assert_eq!(hook::rate_bps(true, true), 0);
    assert_eq!(hook::rate_bps(false, true), 300);
    let mut s = hook::DipState {
        version: 1,
        bump: 0,
        mint: Pubkey::default(),
        reference: 0,
        price: 0,
        moved_at: 0,
        dip: false,
        dip_since: 0,
        dips: 0,
        trades: 0,
        launch: Pubkey::default(),
        creator: Pubkey::default(),
        reserved: [0; 64],
    };
    assert!(!s.observe(1_000_000, 10));
    for _ in 0..50 {
        assert!(s.observe(1, 10));
    }
    assert_eq!(s.reference, 1_000_000, "never within a second");
    let mut t = hook::DipState { reference: 1_000_000, price: 1_000_000, moved_at: 0, ..s };
    assert!(!t.observe(851_000, 0));
    assert!(t.observe(849_000, 0));
    let mut u = hook::DipState { reference: 1_000_000, price: 500_000, moved_at: 0, dip: false, ..s };
    u.observe(500_000, hook::REFERENCE_SECS / 2);
    assert_eq!(u.reference, 750_000);
    u.observe(500_000, hook::REFERENCE_SECS * 10);
    assert_eq!(u.reference, 500_000);
    assert!(script::step::above(1_030_001, 1_000_000));
    assert!(!script::step::above(1_030_000, 1_000_000));
    assert!(script::step::above(1, 0), "no reference: wait");
    assert!(script::step::strays(969_999, 1_000_000));
    assert!(!script::step::strays(970_000, 1_000_000));
    assert_eq!(script::step::budget(100 * SOL, 10 * SOL as u128, 0), SOL / 10);
    assert_eq!(script::step::budget(100 * SOL, 1_000 * SOL as u128, 0), script::MAX_SPEND_LAMPORTS);
    assert_eq!(script::step::budget(SOL / 1_000, 1_000 * SOL as u128, 0), 0, "too little pot");
    assert_eq!(script::step::pregrad_room(10 * SOL, 0), 5 * SOL);
    assert_eq!(script::step::pregrad_room(5 * SOL, 5 * SOL), 0, "half of all the pot had");
    assert_eq!(script::step::pregrad_room(8 * SOL, 2 * SOL), 3 * SOL);
}

/// The step sequence against Bordrless's live wBORDR/SOL pool (cloned from mainnet: its reserves,
/// its 30 bps LP fee and 1% protocol fee): wBORDR bought on it, the coin/wBORDR pool created at the
/// implied price, then an add; the live pool's books kept.
#[test]
fn steps_against_the_live_wbordr_pool() {
    let mut p = Pair::launched();
    p.w.env.warp(31);
    p.fill_pot(SOL);
    p.step_until(action::HOLD, 5);
    p.graduate();
    p.claim();
    let live = p.clone_live_wbordr_pool();
    println!(
        "live pool: {} wBORDR base units, {} lamports, LP fee {} bps, protocol fee {} bps, LP {}",
        live.base_reserve, live.quote_reserve, live.lp_fee_bps, live.protocol_fee_bps, live.lp_supply
    );
    let mut bought = None;
    for _ in 0..400 {
        let before = p.w.env.read::<bordrless_swap::state::Pool>(&WBORDR_POOL);
        let lamports0 = p.w.env.lamports(&WBORDR_POOL);
        let held0 = p.state().wbordr_held;
        p.claim();
        let tx = p.step();
        if tx.result.is_err() {
            continue;
        }
        stepped(&tx);
        if p.state().last_action != action::BUY_WBORDR {
            continue;
        }
        let after = p.w.env.read::<bordrless_swap::state::Pool>(&WBORDR_POOL);
        let got = before.base_reserve - after.base_reserve;
        let work = p.w.env.lamports(&WBORDR_POOL) - lamports0;
        assert_eq!(got, p.state().wbordr_held - held0);
        assert!(u128::from(work) * 10_000 <= u128::from(before.quote_reserve) * 100 + 10_000, "1% of the live pool's SOL side");
        let k = |net: u64| (u128::from(before.base_reserve) * u128::from(net) / (u128::from(before.quote_reserve) + u128::from(net))) as u64;
        let with_fees = k(work - work / 100 - work * 30 / 10_000);
        println!("bought {got} wBORDR for {work} lamports: after the 1.3% fees {with_fees}; {} CU", tx.cu());
        assert!(got < k(work) && got + got / 500 >= with_fees, "the live fees");
        assert_eq!(after.protocol_fees_quote - before.protocol_fees_quote, work / 100, "the 1% protocol fee");
        bought = Some(got);
        break;
    }
    assert!(bought.is_some(), "a wBORDR buy on the live pool");
    let log = p.step_until(action::CREATE_PAIR, 400);
    println!("to the pair pool: {log:?}");
    let pair = p.w.env.read::<bordrless_swap::state::Pool>(&p.pair_pool());
    let wpool = p.w.env.read::<bordrless_swap::state::Pool>(&WBORDR_POOL);
    let lpool = p.w.launch_pool(&p.mint);
    let implied = script::step::implied_price(
        hook::price(lpool.base_reserve, lpool.virtual_base, lpool.quote_reserve, lpool.virtual_quote),
        hook::price(wpool.base_reserve, 0, wpool.quote_reserve, 0),
    )
    .unwrap();
    assert!(!script::step::strays(hook::price(pair.base_reserve, 0, pair.quote_reserve, 0), implied));
    let locked = p.locked_lp();
    assert!(locked > 0 && locked == p.state().pair_lp_locked);
    let mut added = false;
    for _ in 0..400 {
        p.claim();
        let tx = p.step();
        if tx.result.is_ok() {
            stepped(&tx);
            if p.state().last_action == action::ADD_PAIR {
                added = true;
                break;
            }
        }
    }
    assert!(added, "an add: {:?}", p.state());
    assert!(p.locked_lp() > locked);
    let wpool = p.w.env.read::<bordrless_swap::state::Pool>(&WBORDR_POOL);
    assert!(p.w.env.lamports(&WBORDR_POOL) >= p.w.env.rent(411) + wpool.quote_reserve + wpool.protocol_fees_quote);
    println!("live pool after: {} wBORDR, {} lamports; the pair pool locked {} LP", wpool.base_reserve, wpool.quote_reserve, p.locked_lp());
}
