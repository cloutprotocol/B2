//! B², the script half: a Bordrless companion script that turns the pot into BORDR liquidity
//! locked for ever, in two equal pools: the coin's own launch pool (coin/SOL) and coin/wBORDR.
//!
//! The companion calls [`bordr_pair_script::companion_step`] at most once every keeper.json
//! `stepSecs` (60 seconds), with the companion address signing. A step does one thing:
//!
//! - **On the curve** (before graduation), from the end of the launch's sniper window
//!   ([`SNIPER_SKIP_SECS`] at least):
//!   - **Dip Buy:** while the hook half's state says the coin is in a dip, and the dip has held for
//!     two step observations in a row or [`DIP_HOLD_SECS`], it buys the coin with pot SOL and holds
//!     it with the rest, for the liquidity: the pot buys cheap at the dip.
//!   - **Hold:** otherwise it buys a little of the coin on the curve and keeps it (in the companion
//!     address's holding, beside any dev bag, which it never touches), at most [`PREGRAD_POT_BPS`] of
//!     the pot in all before graduation, so SOL is left for the liquidity's SOL side.
//! - **After graduation**, the first step starts the coin's reference over at the graduated
//!   pool's price (graduation moves the price for good, and the reference would take hours to
//!   follow it) and only observes; then the held coin first, half to each pool; then, the same dip
//!   rule first (a dip's coin, after graduation, half to each pool):
//!   - **Coin/SOL:** coin it holds for the launch pool is added with pot SOL at the pool's ratio,
//!     the LP minted straight into the launch's LP holding, `PDA(["holding", lp_mint, launch])`,
//!     which only the launch could move, and its launchpad has no instruction that moves LP.
//!   - **Coin/wBORDR:** wBORDR is bought with pot SOL on the wBORDR/SOL pool to match the coin it
//!     holds for the pair, and both are added to the coin/wBORDR pool (fee tier
//!     [`PAIR_LP_FEE_BPS`]), created on the first add at the price the two SOL pools imply; all its
//!     LP goes to the launch's holding of that pool's LP mint, locked the same way.
//!   - **Heal:** a coin/wBORDR pool more than [`GUARD_BPS`] off the implied price (anyone may make
//!     it first, at any price) is traded back to it with the side the script holds that does so:
//!     the pot buys the cheap side, so making the pool at a wrong price only gives to the pot.
//!   - Otherwise it buys the coin for whichever pool has had less of the pot: [`LIQ_SOL_POOL_BPS`]
//!     of it to coin/SOL, the rest to coin/wBORDR (half and half). While coin/wBORDR can't be
//!     added to (no wBORDR/SOL pool, a pool it can't heal, its creation's accounts missing), the
//!     pot goes on to coin/SOL rather than waiting, and coin/wBORDR catches up once it can.
//!
//! Its guards, each a constant below. A spend is at most [`MAX_SPEND_LAMPORTS`], [`DEPTH_BPS`] of
//! its pool's SOL side and [`POT_SHARE_BPS`] of the pot above [`POT_FLOOR_LAMPORTS`], every swap
//! with a minimum output (its pool's own quote less the fees and [`SLIPPAGE_BPS`]). A buy waits
//! while its pool's price is more than [`GUARD_BPS`] above the script's own one-hour reference for
//! it ([`REFERENCE_SECS`], moving over time only); an add waits while a price it relies on strays
//! more than [`GUARD_BPS`] from its reference, or the coin/wBORDR pool from the price the SOL pools
//! imply.
//!
//! **Every lamport a step spends goes into the liquidity** (and the rent of the accounts it holds
//! it in): the script pays no one. The builder earns the Workshop's builder share, which the
//! companion pays out of the launcher's part of each claim, never the pot.
//!
//! **Idle steps fail:** a step with nothing to do (on the curve inside the sniper window, the pot
//! under its minimum or capped, a guard waiting) fails with
//! [`ScriptError::Idle`] and changes nothing, so Bordrless's keeper, which simulates every step
//! first, never sends it and no bounty leaves the pot for it. A step that only observes succeeds:
//! one that sets a reference for the first time, renews references older than
//! [`OBSERVE_SECS`], or sees a dip for the first time (so its persistence is on record). A step
//! built without an account keeper.json asks for fails ([`ScriptError::MissingAccount`]).
//!
//! Every account a step uses beyond the six the companion names is looked up by its key, and every
//! key is derived here from the mint, the launch and the constants: nothing the sender passes is
//! trusted. keeper.json asks for the launch pool's swap accounts (the coin's hook accounts in them
//! carry the launch pool's LP mint and the launch's LP holding, as the hook's registry lists them);
//! for the coin/wBORDR and wBORDR/SOL pools, their accounts (`pools`). It fixes `launcherShareBps`
//! at 4,000: 40% of every launch's fee to the launcher's creator fee, 60% to the pot.
//!
//! The script never writes the hook's data and the hook never reads the pot. The hook half's state
//! layout this script reads (the hook's module docs hold the same table): the Anchor
//! discriminator `sha256("account:DipState")[..8]` at 0, the mint at 10, the reference price
//! (u128 LE, 2^48 fixed point) at 42, the dip flag at 82, when the dip began (i64 LE) at 83.

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use bordrless_launch::state::Launch;

pub mod dex;
pub mod layout;
pub mod step;

declare_id!("Hz8Qd63skm6r5mpJupyTqK16uqnhfRGCb8CRRhZZPe2M");

/// The companion program: its `["creator", mint]` (the companion address) signs every call.
pub const COMPANION_PROGRAM: Pubkey =
    Pubkey::from_str_const("6ZUM1gWBH9hBBNoJoaVAGwSftyZ6CUda6vUZTW9MsJuo");
/// The Bordrless DEX.
pub const SWAP_PROGRAM: Pubkey =
    Pubkey::from_str_const("GyzKSnnEu2uN5bBRecE4XYY2enbfR2D2MtxnbJPGy7hk");
/// The Bordrless bridge (wraps the pot's SOL for the launch pool's deposit).
pub const BRIDGE_PROGRAM: Pubkey =
    Pubkey::from_str_const("CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7");
/// The Bordrless token program.
pub const TOKEN_PROGRAM: Pubkey = bordrless_token::ID;
/// The system program.
pub const SYSTEM_PROGRAM: Pubkey = anchor_lang::system_program::ID;
/// Bridged SOL: the quote mint (and seed) of every SOL pool, native ones included.
pub const BRIDGED_SOL_MINT: Pubkey =
    Pubkey::from_str_const("A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i");
/// wBORDR: BORDR's 1:1 Bordrless twin from the bridge (no hook), the pair's other side.
pub const WBORDR_MINT: Pubkey =
    Pubkey::from_str_const("APpT4aqDoXAVz6S9wVWCJdqayFcs4tvfj5jToffVncwv");

/// The companion's `["creator", mint]`: the companion address.
pub const CREATOR_SEED: &[u8] = b"creator";
/// The companion's `["companion", mint]`.
pub const COMPANION_SEED: &[u8] = b"companion";
/// The companion's `["script-state", mint]`: this script's state.
pub const SCRIPT_STATE_SEED: &[u8] = b"script-state";
/// The launchpad's `["launch", mint]`.
pub const LAUNCH_SEED: &[u8] = b"launch";

/// The coin/wBORDR pool's LP fee tier (keeper.json `feeBps` 100): the pool this script creates.
/// 1%, so a trade routed around the launch pool through coin/wBORDR and wBORDR/SOL costs more than
/// the launch pool itself (whose fees fill the pot), and what it does pay deepens the locked LP.
pub const PAIR_LP_FEE_BPS: u16 = 100;
/// The wBORDR/SOL pool's LP fee tier: Bordrless's native pool is at 30 bps (keeper.json `feeBps`
/// 30).
pub const WBORDR_POOL_LP_FEE_BPS: u16 = 30;
/// Bordrless's wBORDR/SOL native pool: `PDA(["pool", wBORDR, bridged SOL, WBORDR_POOL_LP_FEE_BPS
/// (u16 LE), default key], DEX)`.
pub const WBORDR_SOL_POOL: Pubkey =
    Pubkey::from_str_const("BtVzohbo3J6sBqk3L8MQVEKP4Bzg1YPmqX3Pc3oWxKnL");

/// The pot's liquidity going to the coin's launch pool (coin/SOL): half; the rest to coin/wBORDR.
pub const LIQ_SOL_POOL_BPS: u128 = 5_000;
/// The most of the pot the script spends before graduation, all told: half.
pub const PREGRAD_POT_BPS: u128 = 5_000;
/// No buy on the curve within this long of the launch (or its sniper window, if longer).
pub const SNIPER_SKIP_SECS: i64 = 60;
/// A dip is bought once it has held this long (or for two step observations in a row).
pub const DIP_HOLD_SECS: i64 = 120;
/// Step observations in a row a dip must hold before it is bought.
pub const DIP_HOLD_STEPS: u8 = 2;
/// A step that only observes renews references at most this often: 15 minutes.
pub const OBSERVE_SECS: i64 = 900;

/// The most one step spends: 0.5 SOL.
pub const MAX_SPEND_LAMPORTS: u64 = 500_000_000;
/// The most one step spends of its pool's SOL side: 1%.
pub const DEPTH_BPS: u128 = 100;
/// The most one step spends of the pot above the floor: half.
pub const POT_SHARE_BPS: u128 = 5_000;
/// What the pot always keeps for the steps' bounties: 0.001 SOL.
pub const POT_FLOOR_LAMPORTS: u64 = 1_000_000;
/// The least a buy spends: 0.001 SOL (below it the step is idle).
pub const MIN_SPEND_LAMPORTS: u64 = 1_000_000;
/// What the pot must hold above the floor before the step that creates the coin/wBORDR pool (the
/// pool's, its LP mint's, its vaults' and the LP holdings' rent): 0.03 SOL.
pub const POOL_RENT_LAMPORTS: u64 = 30_000_000;
/// How far under its pool's own quote (less the fees) a buy's output may land: 2%.
pub const SLIPPAGE_BPS: u128 = 200;
/// How far a price may run above its reference before a buy waits, and how far a price may stray
/// before an add waits: 3%.
pub const GUARD_BPS: u128 = 300;
/// The script's references close the gap to the standing price over this many seconds: one hour.
pub const REFERENCE_SECS: i64 = 3_600;
/// A dip: the price more than 15% under the hook half's reference (the hook's own threshold).
pub const DIP_DEPTH_BPS: u128 = 1_500;
/// Basis points in a whole.
pub const BPS: u128 = 10_000;
/// Fractional bits of a price (the hook half's).
pub const PRICE_SHIFT: u32 = 48;

/// What a step did ([`Stepped::action`], [`PairState::last_action`]).
pub mod action {
    /// Observed only: a reference set or renewed, or a dip's first sighting.
    pub const OBSERVE: u8 = 0;
    /// Bought wBORDR on the wBORDR/SOL pool, for the pair.
    pub const BUY_WBORDR: u8 = 1;
    /// Bought the coin on the launch pool for one of the two pools.
    pub const BUY_COIN: u8 = 2;
    /// Created the coin/wBORDR pool with its first liquidity, the LP locked.
    pub const CREATE_PAIR: u8 = 3;
    /// Added to the coin/wBORDR pool, the LP locked.
    pub const ADD_PAIR: u8 = 4;
    /// Bought the coin in a dip, for the liquidity.
    pub const DIP_BUY: u8 = 5;
    /// Bought the coin on the curve and held it, for the liquidity after graduation.
    pub const HOLD: u8 = 6;
    /// Added to the coin's launch pool (coin/SOL), the LP locked.
    pub const ADD_SOL_POOL: u8 = 7;
    /// Traded the coin/wBORDR pool back to the price the SOL pools imply (it had strayed, or
    /// someone made it first at another price), with what the script holds for it.
    pub const HEAL_PAIR: u8 = 8;
}

/// Why a step was idle ([`ScriptError::Idle`]'s log line).
pub mod idle {
    /// Inside the launch's sniper window.
    pub const SNIPER: &str = "sniper window";
    /// The launch is not native SOL (a coin launched before 15 Oct 2026).
    pub const NOT_NATIVE: &str = "not native";
    /// The DEX is paused.
    pub const PAUSED: &str = "dex paused";
    /// The wBORDR/SOL pool doesn't exist yet.
    pub const NO_WBORDR_POOL: &str = "no wBORDR/SOL pool";
    /// A price is more than the guard above its reference.
    pub const PRICE_ABOVE_REFERENCE: &str = "price above reference";
    /// A price strays from its reference, or the pair pool from the implied price.
    pub const STRAYS: &str = "price strays";
    /// The pot holds too little.
    pub const POT: &str = "pot too small";
    /// The pre-graduation share of the pot is spent.
    pub const PREGRAD_CAP: &str = "pre-graduation cap";
    /// Creating the coin/wBORDR pool needs the DEX's config writable and its treasury.
    pub const ACCOUNTS: &str = "dex config or treasury";
    /// Too little for any pool to take.
    pub const TOO_SMALL: &str = "too small";
    /// A dip seen, not yet held long enough.
    pub const DIP_FRESH: &str = "dip not held yet";
}

/// Instructions of the script (the companion calls both, with the companion address signing).
#[program]
pub mod bordr_pair_script {
    use super::*;

    /// Once, when the companion sets the launch up (before the mint exists): the script's state,
    /// which the companion made zeroed and owned by this program. Spends nothing; every setting is
    /// a constant of this program, so `init_data` is not read.
    pub fn companion_init(ctx: Context<CompanionInit>, mint: Pubkey, init_data: Vec<u8>) -> Result<()> {
        let _ = init_data;
        let state = &mut ctx.accounts.state;
        state.version = 1;
        state.mint = mint;
        Ok(())
    }

    /// A step: see the module.
    pub fn companion_step<'info>(ctx: Context<'info, CompanionStep<'info>>, mint: Pubkey) -> Result<()> {
        step::run(ctx, mint)
    }
}

/// Accounts of `companion_init` (the companion's order), then any it forwards (unused).
#[derive(Accounts)]
#[instruction(coin: Pubkey)]
pub struct CompanionInit<'info> {
    /// The companion address of `mint`: only the companion can sign for it.
    #[account(mut, seeds = [CREATOR_SEED, coin.as_ref()], bump, seeds::program = COMPANION_PROGRAM)]
    pub creator: Signer<'info>,
    /// CHECK: the mint (address-checked; not created yet).
    #[account(address = coin @ ScriptError::WrongAccount)]
    pub mint: UncheckedAccount<'info>,
    /// The script's state, made by the companion: zeroed, owned by this program.
    #[account(zero, seeds = [SCRIPT_STATE_SEED, coin.as_ref()], bump, seeds::program = COMPANION_PROGRAM)]
    pub state: Account<'info, PairState>,
    pub system_program: Program<'info, System>,
}

/// Accounts of `companion_step` (the companion's six), then the keeper's (keeper.json), found by
/// key.
#[derive(Accounts)]
#[instruction(coin: Pubkey)]
pub struct CompanionStep<'info> {
    /// The companion address of `mint`: signs every swap, deposit and transfer.
    #[account(mut, seeds = [CREATOR_SEED, coin.as_ref()], bump, seeds::program = COMPANION_PROGRAM)]
    pub creator: Signer<'info>,
    /// CHECK: the coin's mint (address-checked; read for its hook).
    #[account(address = coin @ ScriptError::WrongAccount)]
    pub mint: UncheckedAccount<'info>,
    /// The coin's launch.
    #[account(seeds = [LAUNCH_SEED, coin.as_ref()], bump, seeds::program = bordrless_launch::ID)]
    pub launch: Box<Account<'info, Launch>>,
    /// CHECK: the companion of `mint` (seeds-checked; read for the pot and the dev bag).
    #[account(seeds = [COMPANION_SEED, coin.as_ref()], bump, seeds::program = COMPANION_PROGRAM)]
    pub companion: UncheckedAccount<'info>,
    /// CHECK: the launch's pool (address-checked).
    #[account(address = launch.pool @ ScriptError::WrongAccount)]
    pub pool: UncheckedAccount<'info>,
    /// The script's state.
    #[account(mut, seeds = [SCRIPT_STATE_SEED, coin.as_ref()], bump, seeds::program = COMPANION_PROGRAM)]
    pub state: Box<Account<'info, PairState>>,
}

/// The script's state, `PDA(["script-state", mint], companion)` (keeper.json `stateLen`: 8 +
/// `PairState::INIT_SPACE` = 307 bytes).
#[account]
#[derive(InitSpace, Debug)]
pub struct PairState {
    /// Layout version.
    pub version: u8,
    /// The coin.
    pub mint: Pubkey,
    /// Coin bought on the curve and held, not yet given to a pool.
    pub coin_hold: u64,
    /// Coin held for the launch pool (coin/SOL).
    pub coin_for_sol: u64,
    /// Coin held for the coin/wBORDR pool.
    pub coin_for_pair: u64,
    /// wBORDR held for the coin/wBORDR pool.
    pub wbordr_held: u64,
    /// The script's reference for the launch pool's price (0 before the first step that saw it).
    pub coin_reference: u128,
    /// The launch pool's price at the last step.
    pub coin_price: u128,
    /// When the coin reference last moved.
    pub coin_moved_at: i64,
    /// The script's reference for the wBORDR/SOL pool's price.
    pub wbordr_reference: u128,
    /// The wBORDR/SOL pool's price at the last step that saw it.
    pub wbordr_price: u128,
    /// When the wBORDR reference last moved.
    pub wbordr_moved_at: i64,
    /// Lamports of the pot given to the launch pool's side (its coin and its SOL).
    pub sol_leg: u64,
    /// Lamports of the pot given to the coin/wBORDR side (its coin and its wBORDR).
    pub pair_leg: u64,
    /// Lamports spent before graduation (the held coin and the curve's dips).
    pub pregrad_spent: u64,
    /// Step observations in a row that saw a dip.
    pub dip_streak: u8,
    /// When the last step ran (every step that succeeded).
    pub last_step_at: i64,
    /// Steps so far.
    pub steps: u64,
    /// The last step's action (`action::*`).
    pub last_action: u8,
    /// SOL spent on dip buys, all time.
    pub sol_to_dip: u64,
    /// Coin the dip buys bought (for the liquidity), all time.
    pub dip_bought: u64,
    /// LP locked in the launch's holding of the launch pool's LP, all time.
    pub sol_pool_lp_locked: u64,
    /// LP locked in the launch's holding of the coin/wBORDR pool's LP, all time.
    pub pair_lp_locked: u64,
    /// Whether a step has run since graduation (the first one starts the coin's reference over at
    /// the graduated pool's price).
    pub graduated_seen: bool,
    /// Reserved, zero (keeps the state at keeper.json's `stateLen`).
    pub reserved: [u8; 79],
}

/// One step: what it did, what it spent and what it got.
#[event]
pub struct Stepped {
    pub mint: Pubkey,
    /// `action::*`.
    pub action: u8,
    /// Lamports of the pot the action spent.
    pub sol: u64,
    /// Coin or wBORDR bought, or LP locked.
    pub amount: u64,
    /// The pot before the step.
    pub pot: u64,
}

/// Errors.
#[error_code]
pub enum ScriptError {
    #[msg("an account is not the one this script expects")]
    WrongAccount,
    #[msg("an account keeper.json asks for was not passed, or not writable")]
    MissingAccount,
    #[msg("nothing to do this step")]
    Idle,
}
