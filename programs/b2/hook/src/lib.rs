//! B², the hook half: a Bordrless token hook that answers the launchpad's SOL cut (Dip Buy) and
//! carries, in its registry, the accounts its pair's script locks liquidity with.
//!
//! - **The SOL cut.** On every trade the launchpad asks [`bordr_pair_hook::quote_cut`] for a rate
//!   of the trade's SOL (`docs/quote-cut.md`; caps in hook.json). A buy and a sell pay [`RATE_BPS`];
//!   while the price is more than [`DIP_DEPTH_BPS`] under the reference (a dip), a buy pays
//!   [`DIP_BUY_BPS`] and a sell [`DIP_SELL_BPS`]. On a pair the SOL lands whole in the pot, which
//!   the script half spends. The launch's creator (the companion address) trades exempt.
//! - **The reference.** One per mint, in the hook's state. It moves over time only: at each trade
//!   it closes the gap to the price that stood since it last moved, by the seconds elapsed over
//!   [`REFERENCE_SECS`] (six hours), and not at all within the same second. The price a trade
//!   brings is only compared with it; it moves the reference once time has passed with it
//!   standing. So one transaction (or a burst within one second) can't move it.
//! - **Transfers** are answered with nothing: no cut, no hook data, never a refusal, so every
//!   holding stays closable. `before_transfer` checks its caller and the operation only.
//!
//! The hook calls no program and moves no SOL.
//!
//! ## Layouts shared with the script half (it reads them; it never writes them)
//!
//! The hook's state, `PDA(["state", mint], hook)` (`DipState`, an Anchor account), by byte offset:
//!
//! | Offset | Bytes | Field |
//! |---|---|---|
//! | 0 | 8 | Anchor discriminator, `sha256("account:DipState")[..8]` |
//! | 8 | 1 | version (1) |
//! | 9 | 1 | bump |
//! | 10 | 32 | mint |
//! | 42 | 16 | reference price, u128 LE ([`PRICE_SHIFT`] fractional bits; 0 before the first trade) |
//! | 58 | 16 | price at the last trade, u128 LE |
//! | 74 | 8 | when the reference last moved, i64 LE |
//! | 82 | 1 | dip: 1 while the last trade saw a dip |
//! | 83 | 8 | when the current dip began, i64 LE (0 outside one) |
//! | 91 | 8 | dips so far, u64 LE |
//! | 99 | 8 | trades the launchpad asked about, u64 LE |
//! | 107 | 32 | the launch, `PDA(["launch", mint], launchpad)` |
//! | 139 | 32 | the companion address, `PDA(["creator", mint], companion)` |
//! | 171 | 64 | reserved, zero |
//!
//! A price is quote base units (lamports) per base unit of the token, the pool's reserves with
//! their virtual offsets, times 2^48. Holdings' hook data: never written (all zeros).
//!
//! The registry (`prepare`, never written again) lists three extras after the token program's
//! five, as Bordrless's LiquidityTek hook does: the state; the launch pool's LP mint (writable) and
//! the launch's holding of it (writable), where the pool's locked LP lives. The script half adds
//! liquidity to the launch pool with them; they ride in every step's swap accounts.

use anchor_lang::prelude::*;
use bordrless_game::{COMPANION_PROGRAM_ID, LAUNCH_PROGRAM_ID, TOKEN_PROGRAM_ID};
use bordrless_hook::{
    hook_accounts_address, hook_signer, write_registry, AccountSource, ExtraAccount,
    HookAccountList, HookReturn, PoolHookArgs, Seed, TokenHookArgs, TokenOp,
};

declare_id!("CgE7cev4NEWoKskQgvUQgfe3xh8ivwgut7zNzo4i3iRB");

/// `["state", mint]`: the hook's state for a mint (the template's seed; the launchpad passes it
/// writable to `quote_cut`).
pub const STATE_SEED: &[u8] = b"state";
/// The launchpad's `["launch", mint]` seed.
pub const LAUNCH_SEED: &[u8] = b"launch";
/// The companion's `["creator", mint]` seed: the companion address of a pair's launch.
pub const CREATOR_SEED: &[u8] = b"creator";
/// The launchpad's `["quote-cut", hook]` seed: its signer of this hook's `quote_cut`.
pub const QUOTE_CUT_SEED: &[u8] = b"quote-cut";

/// The SOL cut outside a dip, on a buy and on a sell: 1%.
pub const RATE_BPS: u16 = 100;
/// The SOL cut on a buy in a dip: 0%.
pub const DIP_BUY_BPS: u16 = 0;
/// The SOL cut on a sell in a dip: 3%.
pub const DIP_SELL_BPS: u16 = 300;
/// How far under the reference the price must be for a dip: more than 15%.
pub const DIP_DEPTH_BPS: u128 = 1_500;
/// The reference closes the gap to the standing price over this many seconds: six hours.
pub const REFERENCE_SECS: i64 = 21_600;
/// Basis points in a whole.
pub const BPS: u128 = 10_000;
/// Fractional bits of a price.
pub const PRICE_SHIFT: u32 = 48;
/// The Bordrless DEX, whose launch pool's LP the registry names.
pub const DEX_PROGRAM_ID: Pubkey = Pubkey::from_str_const("GyzKSnnEu2uN5bBRecE4XYY2enbfR2D2MtxnbJPGy7hk");
/// Bridged SOL: the quote mint (and seed) of every launch pool.
pub const BRIDGED_SOL_MINT: Pubkey = Pubkey::from_str_const("A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i");
/// The LP fee every launch pool is made with (part of its address): 0.3%.
pub const LAUNCH_LP_FEE_BPS: u16 = 30;

/// A pool's price from its reserves and virtual offsets: quote per base, [`PRICE_SHIFT`]
/// fractional bits; 0 for an empty base side.
pub fn price(base_reserve: u64, virtual_base: u64, quote_reserve: u64, virtual_quote: u64) -> u128 {
    let base = u128::from(base_reserve) + u128::from(virtual_base);
    let quote = u128::from(quote_reserve) + u128::from(virtual_quote);
    if base == 0 {
        return 0;
    }
    (quote << PRICE_SHIFT) / base
}

/// The SOL cut in basis points: a buy or a sell (`buy`), in a dip or not (`dip`).
pub fn rate_bps(buy: bool, dip: bool) -> u16 {
    match (buy, dip) {
        // A buy in a dip.
        (true, true) => DIP_BUY_BPS,
        // A sell in a dip.
        (false, true) => DIP_SELL_BPS,
        // A buy or a sell outside a dip.
        _ => RATE_BPS,
    }
}

/// Whether `price` is more than [`DIP_DEPTH_BPS`] under `reference` (never with no reference).
pub fn is_dip(price: u128, reference: u128) -> bool {
    reference != 0 && price < reference / BPS * (BPS - DIP_DEPTH_BPS)
}

/// The hook's state of `mint`.
pub fn state_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[STATE_SEED, mint.as_ref()], &crate::ID).0
}

/// The launch pool of `mint`: `PDA(["pool", mint, bridged SOL, LAUNCH_LP_FEE_BPS (u16 LE),
/// launchpad], DEX)`; its LP mint, `PDA(["lp", pool], DEX)`; the launch's holding of that LP mint,
/// `PDA(["holding", lp_mint, launch], token program)`, which holds the pool's LP for ever.
pub fn launch_lp_accounts(mint: &Pubkey) -> (Pubkey, Pubkey) {
    let pool = Pubkey::find_program_address(
        &[
            b"pool",
            mint.as_ref(),
            BRIDGED_SOL_MINT.as_ref(),
            &LAUNCH_LP_FEE_BPS.to_le_bytes(),
            LAUNCH_PROGRAM_ID.as_ref(),
        ],
        &DEX_PROGRAM_ID,
    )
    .0;
    let lp_mint = Pubkey::find_program_address(&[b"lp", pool.as_ref()], &DEX_PROGRAM_ID).0;
    let launch = Pubkey::find_program_address(&[LAUNCH_SEED, mint.as_ref()], &LAUNCH_PROGRAM_ID).0;
    let holding = Pubkey::find_program_address(
        &[b"holding", lp_mint.as_ref(), launch.as_ref()],
        &TOKEN_PROGRAM_ID,
    )
    .0;
    (lp_mint, holding)
}

/// The callbacks' extras after the token program's five: the state, then the launch pool's LP
/// mint and the launch's LP holding (both writable: the script half's liquidity adds write them).
pub fn extra_accounts(mint: &Pubkey) -> HookAccountList {
    let (lp_mint, lp_holding) = launch_lp_accounts(mint);
    HookAccountList::new(vec![
        ExtraAccount {
            writable: false,
            source: AccountSource::Pda {
                program: crate::ID,
                seeds: vec![Seed::Literal(STATE_SEED.to_vec()), Seed::Account(1)],
            },
        },
        ExtraAccount {
            writable: true,
            source: AccountSource::Key(lp_mint),
        },
        ExtraAccount {
            writable: true,
            source: AccountSource::Key(lp_holding),
        },
    ])
}

#[program]
pub mod bordr_pair_hook {
    use super::*;

    /// The standard `prepare`: the state for `mint` (which need not exist yet) and its registry.
    /// Anyone may send it, once per mint; every setting is a constant of this program.
    pub fn prepare(ctx: Context<Prepare>) -> Result<()> {
        let mint = ctx.accounts.mint.key();
        let state = &mut ctx.accounts.state;
        state.version = 1;
        state.bump = ctx.bumps.state;
        state.mint = mint;
        state.reference = 0;
        state.price = 0;
        state.moved_at = 0;
        state.dip = false;
        state.dip_since = 0;
        state.dips = 0;
        state.trades = 0;
        state.launch = Pubkey::find_program_address(&[LAUNCH_SEED, mint.as_ref()], &LAUNCH_PROGRAM_ID).0;
        state.creator =
            Pubkey::find_program_address(&[CREATOR_SEED, mint.as_ref()], &COMPANION_PROGRAM_ID).0;
        state.reserved = [0; 64];
        let (registry, bump) = hook_accounts_address(&crate::ID, &mint);
        require_keys_eq!(ctx.accounts.registry.key(), registry, HookError::WrongAccount);
        write_registry(
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.registry.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &crate::ID,
            &mint,
            bump,
            &extra_accounts(&mint),
        )
    }

    /// Before every transfer: the caller checked, nothing answered (no cut, no hook data, no
    /// refusal of a transfer).
    pub fn before_transfer(ctx: Context<Callback>, args: TokenHookArgs) -> Result<HookReturn> {
        check_call(&ctx, &args)?;
        require!(args.op == TokenOp::Transfer, HookError::WrongAccount);
        Ok(HookReturn::default())
    }

    /// The SOL cut the launchpad asks on every trade of the coin (a buy before its swap, a sell
    /// after it), answered as basis points: Dip Buy's rate. Only the launchpad's signer for this
    /// hook is answered; for it, every call is answered (a state it can't read gets the plain rate,
    /// never an error). It writes nothing but the reference and the dip in the hook's state.
    pub fn quote_cut(ctx: Context<QuoteCut>, args: PoolHookArgs) -> Result<u16> {
        let (signer, _) =
            Pubkey::find_program_address(&[QUOTE_CUT_SEED, crate::ID.as_ref()], &LAUNCH_PROGRAM_ID);
        require!(
            ctx.accounts.signer.is_signer && ctx.accounts.signer.key() == signer,
            HookError::NotLaunchpad
        );
        let buy = args.direction == 1;
        let now = Clock::get()?.unix_timestamp;
        let mut dip = false;
        let info = &ctx.accounts.state;
        if info.owner == &crate::ID && info.is_writable {
            let read = info
                .try_borrow_data()
                .ok()
                .and_then(|d| DipState::try_deserialize(&mut &d[..]).ok());
            // The state of this mint at its own address, checked with the bump it keeps (one hash,
            // on every trade, where a search for the bump could take several).
            if let Some(mut state) = read.filter(|s| {
                s.mint == args.base_mint
                    && Pubkey::create_program_address(&[STATE_SEED, s.mint.as_ref(), &[s.bump]], &crate::ID)
                        .is_ok_and(|k| k == info.key())
            }) {
                let price = price(
                    args.base_reserve,
                    args.virtual_base,
                    args.quote_reserve,
                    args.virtual_quote,
                );
                dip = state.observe(price, now);
                state.trades = state.trades.saturating_add(1);
                if let Ok(mut data) = info.try_borrow_mut_data() {
                    let mut out: &mut [u8] = &mut data[..];
                    if state.try_serialize(&mut out).is_err() {
                        dip = false;
                    }
                }
            }
        }
        Ok(rate_bps(buy, dip))
    }
}

/// Every token callback: signed by the token program's signer for this hook, about the mint this
/// state was prepared for.
fn check_call(ctx: &Context<Callback>, args: &TokenHookArgs) -> Result<()> {
    let signer = &ctx.accounts.hook_signer;
    require!(signer.is_signer, HookError::BadHookSigner);
    require_keys_eq!(
        signer.key(),
        hook_signer(&TOKEN_PROGRAM_ID, &crate::ID).0,
        HookError::BadHookSigner
    );
    require_keys_eq!(args.mint, ctx.accounts.state.mint, HookError::WrongAccount);
    Ok(())
}

/// The hook's state for one mint, at `["state", mint]` (layout in the module's docs).
#[account]
#[derive(InitSpace, Debug)]
pub struct DipState {
    /// Layout version.
    pub version: u8,
    /// Bump.
    pub bump: u8,
    /// The mint.
    pub mint: Pubkey,
    /// Dip Buy's reference price; 0 before the first trade.
    pub reference: u128,
    /// The price at the last trade.
    pub price: u128,
    /// When the reference last moved.
    pub moved_at: i64,
    /// Whether the last trade saw a dip.
    pub dip: bool,
    /// When the current dip began (0 outside one).
    pub dip_since: i64,
    /// Dips so far.
    pub dips: u64,
    /// Trades the launchpad asked about so far.
    pub trades: u64,
    /// The launch, `["launch", mint]` under the launchpad.
    pub launch: Pubkey,
    /// The companion address, `["creator", mint]` under the companion.
    pub creator: Pubkey,
    /// Reserved, zero.
    pub reserved: [u8; 64],
}

impl DipState {
    /// Sees `price` at `now` and answers whether it is a dip. The reference first closes the gap
    /// to the price that stood since it last moved, by the time elapsed over [`REFERENCE_SECS`]
    /// (none within the same second); `price` is then compared with it and kept as the standing
    /// price. The first price sets the reference.
    pub fn observe(&mut self, price: u128, now: i64) -> bool {
        if price == 0 {
            return self.dip;
        }
        if self.reference == 0 {
            self.reference = price;
            self.price = price;
            self.moved_at = now;
            return false;
        }
        let elapsed = now.saturating_sub(self.moved_at);
        if elapsed > 0 {
            let w = u128::try_from(elapsed.min(REFERENCE_SECS)).unwrap_or(0);
            let span = u128::try_from(REFERENCE_SECS).unwrap_or(1);
            let standing = self.price;
            self.reference = if standing >= self.reference {
                self.reference + (standing - self.reference) * w / span
            } else {
                self.reference - (self.reference - standing) * w / span
            };
            self.moved_at = now;
        }
        let dip = is_dip(price, self.reference);
        if dip && !self.dip {
            self.dip_since = now;
            self.dips = self.dips.saturating_add(1);
        } else if !dip {
            self.dip_since = 0;
        }
        self.dip = dip;
        self.price = price;
        dip
    }
}

/// Accounts of the standard `prepare`.
#[derive(Accounts)]
pub struct Prepare<'info> {
    /// Pays the rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the mint the hook is prepared for; need not exist yet.
    pub mint: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + DipState::INIT_SPACE, seeds = [STATE_SEED, mint.key().as_ref()], bump)]
    pub state: Account<'info, DipState>,
    /// CHECK: the registry PDA, written here (address-checked in the handler).
    #[account(mut)]
    pub registry: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Accounts of a token callback: the token program's five, then the registry's three.
#[derive(Accounts)]
pub struct Callback<'info> {
    /// CHECK: the token program's signer for this hook (checked in `check_call`).
    pub hook_signer: UncheckedAccount<'info>,
    /// CHECK: the mint.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the source holding.
    pub source: UncheckedAccount<'info>,
    /// CHECK: the destination holding.
    pub destination: UncheckedAccount<'info>,
    /// CHECK: who signed the transfer.
    pub authority: UncheckedAccount<'info>,
    #[account(seeds = [STATE_SEED, mint.key().as_ref()], bump = state.bump)]
    pub state: Account<'info, DipState>,
    /// CHECK: the launch pool's LP mint (carried for the script half; not read here).
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: the launch's LP holding (carried for the script half; not read here).
    pub lp_holding: UncheckedAccount<'info>,
}

/// Accounts of `quote_cut`, as the launchpad passes them (`docs/quote-cut.md`).
#[derive(Accounts)]
pub struct QuoteCut<'info> {
    /// CHECK: the launchpad's signer for this hook (address- and signer-checked in the handler).
    pub signer: UncheckedAccount<'info>,
    /// CHECK: the launch.
    pub launch: UncheckedAccount<'info>,
    /// CHECK: the pool.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the base mint.
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: the quote mint.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: the trader.
    pub actor: UncheckedAccount<'info>,
    /// CHECK: the trader's holding of the token (may not exist).
    pub holding: UncheckedAccount<'info>,
    /// CHECK: `["state", mint]` (owner- and address-checked in the handler; may not exist).
    #[account(mut)]
    pub state: UncheckedAccount<'info>,
}

/// Errors.
#[error_code]
pub enum HookError {
    #[msg("an account is not the one this mint's hook expects")]
    WrongAccount,
    #[msg("the hook signer is not the token program's signer for this hook")]
    BadHookSigner,
    #[msg("quote_cut answers only the launchpad's signer for this hook")]
    NotLaunchpad,
}
