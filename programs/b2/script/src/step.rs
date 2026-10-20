//! `companion_step`: one action a step, chosen in one place ([`decide`]), each guarded, each
//! answered as an [`Outcome`] the state and the [`Stepped`] event record. A step with nothing to
//! do fails with [`ScriptError::Idle`], unless it observed something worth keeping (a first
//! reference, references to renew, a dip's first sighting): then it succeeds as `OBSERVE`.
//!
//! Every key a step uses more than once is derived once, when the step starts ([`Step`]), or when
//! it first reaches the coin/wBORDR pool ([`PairKeys`]); the fixed ones are constants.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use bordrless_launch::client::{self as launch_client, LaunchKeys};
use bordrless_launch::constants::{DEX_CONFIG, STATUS_GRADUATED};
use bordrless_launch::state::Launch;
use bordrless_token::client as token_client;
use bordrless_token::state::Holding;

use crate::dex;
use crate::layout::{
    amount_of, read_companion, read_dex_config, read_dip_state, CompanionView, DexConfigView,
    PoolView,
};
use crate::{
    action, idle, CompanionStep, PairState, ScriptError, Stepped, BPS, BRIDGED_SOL_MINT, DEPTH_BPS,
    DIP_DEPTH_BPS, DIP_HOLD_SECS, DIP_HOLD_STEPS,
    GUARD_BPS, LIQ_SOL_POOL_BPS, MAX_SPEND_LAMPORTS, MIN_SPEND_LAMPORTS, OBSERVE_SECS,
    PAIR_LP_FEE_BPS, POOL_RENT_LAMPORTS, POT_FLOOR_LAMPORTS, POT_SHARE_BPS, PREGRAD_POT_BPS,
    PRICE_SHIFT, REFERENCE_SECS, SLIPPAGE_BPS, SNIPER_SKIP_SECS, SWAP_PROGRAM, TOKEN_PROGRAM,
    WBORDR_MINT, WBORDR_SOL_POOL,
};

/// What a step did.
#[derive(Clone, Copy, Debug, Default)]
pub struct Outcome {
    /// `action::*`.
    pub action: u8,
    /// Lamports of the pot the action spent.
    pub sol: u64,
    /// Coin or wBORDR bought, or LP locked.
    pub amount: u64,
}

/// A step's answer: done, or idle (and why).
enum Next {
    Done(Outcome),
    Idle(&'static str),
}

/// What a step observed that is worth a successful step even when it has nothing else to do.
#[derive(Default)]
struct Observed {
    new_reference: bool,
    dip_first: bool,
}

/// `companion_step`.
pub fn run<'info>(ctx: Context<'info, CompanionStep<'info>>, mint: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mut all: Vec<AccountInfo<'info>> = Vec::with_capacity(5 + ctx.remaining_accounts.len());
    all.push(ctx.accounts.creator.to_account_info());
    all.push(ctx.accounts.mint.to_account_info());
    all.push(ctx.accounts.launch.to_account_info());
    all.push(ctx.accounts.companion.to_account_info());
    all.push(ctx.accounts.pool.to_account_info());
    all.extend(ctx.remaining_accounts.iter().cloned());
    let companion = read_companion(&all[3]);
    let pot = companion.map_or(0, |c| c.pot);
    let creator = ctx.accounts.creator.key();
    let launch_key = ctx.accounts.launch.key();
    let launch_lp_mint = dex::lp_mint_address(&ctx.accounts.launch.pool);
    let launch_lp = token_client::holding_address(&launch_lp_mint, &launch_key);
    let coin = token_client::read_mint(&all[1])?;
    let (slice, hook_state) = match coin.hook_program {
        Some(program) => coin_slice(&mint, program, coin.hook_signer_bump, launch_lp_mint, launch_lp),
        None => (vec![], None),
    };
    let step = Step {
        all: &all,
        creator,
        mint,
        launch_key,
        launch: &ctx.accounts.launch,
        pool: &all[4],
        companion,
        now,
        slice,
        hook_state,
        launch_lp,
        coin_holding: token_client::holding_address(&mint, &creator),
        wbordr_holding: token_client::holding_address(&WBORDR_MINT, &creator),
    };
    let state = &mut ctx.accounts.state;
    let stale = now >= state.last_step_at.saturating_add(OBSERVE_SECS);
    let mut seen = Observed::default();
    let out = match decide(&step, state, &mut seen)? {
        Next::Done(out) => out,
        // A guard waiting on a reference set for the first time, or on references nothing has
        // renewed for OBSERVE_SECS, keeps them (else a price that moved for good would hold every
        // buy for ever); so does a dip's first sighting. Nothing else that is idle is ever sent.
        Next::Idle(reason)
            if seen.dip_first
                || ((seen.new_reference || stale)
                    && (reason == idle::PRICE_ABOVE_REFERENCE || reason == idle::STRAYS)) =>
        {
            msg!("observe ({})", reason);
            Outcome {
                action: action::OBSERVE,
                ..Outcome::default()
            }
        }
        Next::Idle(reason) => {
            msg!("idle: {}", reason);
            return err!(ScriptError::Idle);
        }
    };
    state.steps = state.steps.saturating_add(1);
    state.last_action = out.action;
    state.last_step_at = now;
    emit!(Stepped {
        mint,
        action: out.action,
        sol: out.sol,
        amount: out.amount,
        pot,
    });
    Ok(())
}

/// The coin's token-hook slice for a DEX or token instruction: the hook, the token program's
/// signer for it, then its registry's three extras (the hook half's layout): its state, the launch
/// pool's LP mint (writable) and the launch's LP holding (writable); with the hook and its state.
fn coin_slice(
    mint: &Pubkey,
    program: Pubkey,
    bump: u8,
    lp_mint: Pubkey,
    lp_holding: Pubkey,
) -> (Vec<AccountMeta>, Option<(Pubkey, Pubkey)>) {
    let signer = Pubkey::create_program_address(&[b"hook-authority", program.as_ref(), &[bump]], &TOKEN_PROGRAM)
        .unwrap_or_default();
    let state = Pubkey::find_program_address(&[b"state", mint.as_ref()], &program).0;
    let slice = vec![
        AccountMeta::new_readonly(program, false),
        AccountMeta::new_readonly(signer, false),
        AccountMeta::new_readonly(state, false),
        AccountMeta::new(lp_mint, false),
        AccountMeta::new(lp_holding, false),
    ];
    (slice, Some((program, state)))
}

/// What one step reads, found once.
struct Step<'a, 'info> {
    /// The six named accounts but the state, then every account the sender passed.
    all: &'a [AccountInfo<'info>],
    /// The companion address.
    creator: Pubkey,
    mint: Pubkey,
    launch_key: Pubkey,
    launch: &'a Launch,
    pool: &'a AccountInfo<'info>,
    companion: Option<CompanionView>,
    now: i64,
    /// The coin's token-hook slice ([`coin_slice`]; empty for a coin with no hook).
    slice: Vec<AccountMeta>,
    /// The coin's hook and its state, `PDA(["state", mint], hook)`.
    hook_state: Option<(Pubkey, Pubkey)>,
    /// The launch's holding of the launch pool's LP: where that pool's LP is locked.
    launch_lp: Pubkey,
    /// The companion address's holding of the coin.
    coin_holding: Pubkey,
    /// The companion address's holding of wBORDR.
    wbordr_holding: Pubkey,
}

/// The coin/wBORDR pool's keys, derived once a step reaches it.
struct PairKeys {
    /// The pool, at [`PAIR_LP_FEE_BPS`].
    pool: Pubkey,
    lp_mint: Pubkey,
    /// The companion address's holding of its LP (what an add mints into, before the lock).
    creator_lp: Pubkey,
    /// The launch's holding of its LP: the lock.
    launch_lp: Pubkey,
}

impl PairKeys {
    fn of(s: &Step) -> Self {
        let pool = dex::pool_address(&s.mint, &WBORDR_MINT, PAIR_LP_FEE_BPS);
        let lp_mint = dex::lp_mint_address(&pool);
        Self {
            pool,
            lp_mint,
            creator_lp: token_client::holding_address(&lp_mint, &s.creator),
            launch_lp: token_client::holding_address(&lp_mint, &s.launch_key),
        }
    }
}

impl<'a, 'info> Step<'a, 'info> {
    /// The account at `key` among the step's.
    fn find(&self, key: &Pubkey) -> Option<&'a AccountInfo<'info>> {
        self.all.iter().find(|a| a.key == key)
    }

    /// The account at `key`, which keeper.json asks for (`MissingAccount` without it).
    fn needs(&self, key: &Pubkey) -> Result<&'a AccountInfo<'info>> {
        match self.find(key) {
            Some(info) => Ok(info),
            None => {
                msg!("missing: {}", key);
                err!(ScriptError::MissingAccount)
            }
        }
    }

    /// The balance of the holding at `key`, one this script derived (0 while it doesn't exist),
    /// whose account keeper.json asks for (`MissingAccount` without it).
    fn balance(&self, key: &Pubkey) -> Result<u64> {
        Ok(amount_of(self.needs(key)?))
    }

    /// Whether `ix` can be invoked from the step's accounts: each of its accounts passed, writable
    /// where it is written, the companion address the only signer, the program passed. One of
    /// `waivable` (what only a pool's creation needs beside a swap's accounts) missing or read-only
    /// answers false; any other fails the step (`MissingAccount`). Only an instruction with
    /// waivable accounts needs asking first: [`Step::call`] checks the rest as it goes.
    fn ready(&self, ix: &Instruction, waivable: &[Pubkey]) -> Result<bool> {
        let program = self.find(&ix.program_id).is_some_and(|p| p.executable);
        require!(program, ScriptError::MissingAccount);
        for m in &ix.accounts {
            let ok = (!m.is_signer || m.pubkey == self.creator)
                && self.all.iter().any(|a| {
                    a.key == &m.pubkey && (!m.is_writable || a.is_writable) && (!m.is_signer || a.is_signer)
                });
            if !ok {
                if waivable.contains(&m.pubkey) {
                    return Ok(false);
                }
                msg!("missing or read-only: {}", m.pubkey);
                return err!(ScriptError::MissingAccount);
            }
        }
        Ok(true)
    }

    /// Invokes `ix` with the step's accounts (the companion address signs: it signed the step).
    /// An account it takes that is missing, or read-only where it is written, fails the step
    /// (`MissingAccount`): keeper.json asks for every one.
    fn call(&self, ix: &Instruction) -> Result<()> {
        let mut infos = Vec::with_capacity(ix.accounts.len() + 1);
        for m in &ix.accounts {
            match self.all.iter().find(|a| a.key == &m.pubkey && (!m.is_writable || a.is_writable)) {
                Some(info) => infos.push(info.clone()),
                None => {
                    msg!("missing or read-only: {}", m.pubkey);
                    return err!(ScriptError::MissingAccount);
                }
            }
        }
        infos.push(self.needs(&ix.program_id)?.clone());
        invoke(ix, &infos)?;
        Ok(())
    }

    /// The pot above its floor: what a step may spend at all.
    fn spendable(&self) -> u64 {
        self.companion.map_or(0, |c| c.pot.saturating_sub(POT_FLOOR_LAMPORTS))
    }
}

/// The reference at `reference` after closing the gap to the standing price `standing` by the
/// time since `moved_at` over [`REFERENCE_SECS`] (none within the same second); `price` becomes
/// the standing price. The first price sets the reference, and answers 0: no reference yet.
pub fn observe(reference: &mut u128, standing: &mut u128, moved_at: &mut i64, price: u128, now: i64) -> u128 {
    if price == 0 {
        return *reference;
    }
    if *reference == 0 {
        *reference = price;
        *standing = price;
        *moved_at = now;
        return 0;
    }
    let elapsed = now.saturating_sub(*moved_at);
    if elapsed > 0 {
        let w = u128::try_from(elapsed.min(REFERENCE_SECS)).unwrap_or(0);
        let span = u128::try_from(REFERENCE_SECS).unwrap_or(1);
        let s = *standing;
        *reference = if s >= *reference {
            *reference + (s - *reference) * w / span
        } else {
            *reference - (*reference - s) * w / span
        };
        *moved_at = now;
    }
    *standing = price;
    *reference
}

/// Whether a buy at `price` waits: no reference yet, or more than [`GUARD_BPS`] above it.
pub fn above(price: u128, reference: u128) -> bool {
    reference == 0 || price > reference / BPS * (BPS + GUARD_BPS)
}

/// Whether `price` strays more than [`GUARD_BPS`] from `expected` either way (or there is none).
pub fn strays(price: u128, expected: u128) -> bool {
    let band = expected / BPS * GUARD_BPS;
    expected == 0 || price > expected.saturating_add(band) || price < expected.saturating_sub(band)
}

/// Whether `price` is a dip against the hook half's `reference`: more than [`DIP_DEPTH_BPS`] under.
pub fn is_dip(price: u128, reference: u128) -> bool {
    reference != 0 && price < reference / BPS * (BPS - DIP_DEPTH_BPS)
}

/// `amount` at `price` (2^48 fixed point), rounded down, saturating.
pub fn value(amount: u64, price: u128) -> u128 {
    u128::from(amount).checked_mul(price).map_or(u128::MAX, |v| v >> PRICE_SHIFT)
}

/// `bps` of `amount`.
fn bps_of(amount: u128, bps: u128) -> u128 {
    amount.saturating_mul(bps) / BPS
}

/// The price of the coin in wBORDR the two SOL pools imply (wBORDR base units per coin base unit,
/// 2^48 fixed point): the coin's SOL price over wBORDR's.
pub fn implied_price(coin_price: u128, wbordr_price: u128) -> Option<u128> {
    if wbordr_price == 0 || coin_price == 0 {
        return None;
    }
    match coin_price.checked_shl(PRICE_SHIFT).filter(|v| v >> PRICE_SHIFT == coin_price) {
        Some(shifted) => Some(shifted / wbordr_price),
        None => (coin_price / wbordr_price).checked_shl(PRICE_SHIFT),
    }
    .filter(|p| *p > 0)
}

/// What a spend on a pool with `depth` lamports on its SOL side takes of `spendable`: at most
/// [`MAX_SPEND_LAMPORTS`], [`DEPTH_BPS`] of the depth and [`POT_SHARE_BPS`] of `spendable`; and,
/// with `want` above 0 (what evens the pair), no more than it needs (but at least
/// [`MIN_SPEND_LAMPORTS`]). 0 when the cap is below [`MIN_SPEND_LAMPORTS`].
pub fn budget(spendable: u64, depth: u128, want: u128) -> u64 {
    let cap = u128::from(MAX_SPEND_LAMPORTS)
        .min(bps_of(depth, DEPTH_BPS))
        .min(bps_of(u128::from(spendable), POT_SHARE_BPS));
    if cap < u128::from(MIN_SPEND_LAMPORTS) {
        return 0;
    }
    let spend = if want > 0 {
        want.max(u128::from(MIN_SPEND_LAMPORTS)).min(cap)
    } else {
        cap
    };
    u64::try_from(spend).unwrap_or(0)
}

/// What the pot may still spend before graduation: [`PREGRAD_POT_BPS`] of the pot as it would be
/// had nothing been spent before graduation, less what was.
pub fn pregrad_room(pot: u64, spent: u64) -> u64 {
    let whole = u128::from(pot) + u128::from(spent);
    u64::try_from(bps_of(whole, PREGRAD_POT_BPS).saturating_sub(u128::from(spent))).unwrap_or(0)
}

/// The most a launch-pool buy pays in fees, basis points of its input: the LP fee (the anti-sniper
/// fee while it lasts), the creator and holder fees with Bordrless's quarter of them on top, and
/// the burn (the companion's own buyback bound). The companion address's own buys pay no SOL cut.
pub fn launch_buy_fee_bps(l: &Launch, now: i64) -> u128 {
    let r = &l.rules;
    let lp = if now < l.created_at.saturating_add(l.sniper_window_secs) {
        l.lp_fee_bps.max(l.sniper_start_bps)
    } else {
        l.lp_fee_bps
    };
    let cuts = u128::from(l.creator_fee_bps) + u128::from(r.holder_fee_buy_bps);
    u128::from(lp) + cuts + cuts.div_ceil(4) + u128::from(r.burn_buy_bps)
}

/// The least a buy of `spend` on `pool` must deliver: the pool's own quote of what is left after
/// `fee_bps`, less [`SLIPPAGE_BPS`].
pub fn min_out(pool: &PoolView, spend: u64, fee_bps: u128) -> u64 {
    let net = u64::try_from(bps_of(u128::from(spend), BPS.saturating_sub(fee_bps))).unwrap_or(0);
    let quote = pool.quote_out(net);
    u64::try_from(bps_of(u128::from(quote), BPS - SLIPPAGE_BPS)).unwrap_or(0)
}

/// When a buy on the curve is allowed at all: after [`SNIPER_SKIP_SECS`] and the launch's own
/// sniper window.
pub fn curve_opens_at(l: &Launch) -> i64 {
    l.created_at
        .saturating_add(SNIPER_SKIP_SECS.max(l.sniper_window_secs))
}


/// Below this much SOL's worth, what the script holds for a pool is dust: it neither keeps the
/// pair open nor is added on its own (a step for it would cost more than it moves).
const DUST_LAMPORTS: u128 = MIN_SPEND_LAMPORTS as u128;

/// The one place a step's action is chosen.
fn decide(s: &Step, st: &mut PairState, seen: &mut Observed) -> Result<Next> {
    let l = s.launch;
    if !l.is_native() {
        return Ok(Next::Idle(idle::NOT_NATIVE));
    }
    let graduated = l.status == STATUS_GRADUATED;
    if !graduated && s.now < curve_opens_at(l) {
        return Ok(Next::Idle(idle::SNIPER));
    }
    let Some(config) = read_dex_config(s.needs(&DEX_CONFIG)?) else {
        return err!(ScriptError::WrongAccount);
    };
    if config.paused {
        return Ok(Next::Idle(idle::PAUSED));
    }
    let Some(launch_pool) = PoolView::read(s.pool) else {
        return err!(ScriptError::WrongAccount);
    };
    let coin_price = launch_pool.price();
    // Graduation moves the price for good: the first step after it starts the reference over (it
    // only observes; the next step's guards measure against the graduated price).
    if graduated && !st.graduated_seen {
        st.graduated_seen = true;
        st.coin_reference = 0;
        st.dip_streak = 0;
    }
    let coin_reference = observe(
        &mut st.coin_reference,
        &mut st.coin_price,
        &mut st.coin_moved_at,
        coin_price,
        s.now,
    );
    seen.new_reference |= coin_reference == 0;

    // A dip, held two observations in a row or DIP_HOLD_SECS: buy the coin cheap for the
    // liquidity (on the curve and after it).
    let dip = match s.hook_state {
        Some((program, key)) => read_dip_state(s.needs(&key)?, &program, &s.mint)
            .filter(|d| d.dip && is_dip(coin_price, d.reference)),
        None => None,
    };
    let dip_room = if graduated {
        s.spendable()
    } else {
        s.spendable().min(pregrad_room(s.companion.map_or(0, |c| c.pot), st.pregrad_spent))
    };
    match dip.filter(|_| budget(dip_room, launch_pool.quote_depth(), 0) > 0) {
        Some(d) => {
            let held = st.dip_streak.saturating_add(1) >= DIP_HOLD_STEPS
                || (d.dip_since > 0 && s.now >= d.dip_since.saturating_add(DIP_HOLD_SECS));
            st.dip_streak = st.dip_streak.saturating_add(1);
            if !held {
                seen.dip_first = true;
                return Ok(Next::Idle(idle::DIP_FRESH));
            }
            return dip_buy(s, st, &launch_pool, graduated);
        }
        None => st.dip_streak = 0,
    }

    // On the curve: buy a little and hold it.
    if !graduated {
        let room = pregrad_room(s.companion.map_or(0, |c| c.pot), st.pregrad_spent);
        if room < MIN_SPEND_LAMPORTS {
            return Ok(Next::Idle(idle::PREGRAD_CAP));
        }
        let spend = budget(s.spendable().min(room), launch_pool.quote_depth(), 0);
        if spend == 0 {
            let uncapped = budget(s.spendable(), launch_pool.quote_depth(), 0);
            return Ok(Next::Idle(if uncapped > 0 { idle::PREGRAD_CAP } else { idle::POT }));
        }
        if above(coin_price, coin_reference) {
            return Ok(Next::Idle(idle::PRICE_ABOVE_REFERENCE));
        }
        return buy_coin(s, st, &launch_pool, spend, Leg::Hold);
    }

    // After graduation: the held coin first, half to each pool, with half of what it cost.
    let dev_bag = s.companion.map_or(u64::MAX, |c| c.dev_bag);
    let mut free = s.balance(&s.coin_holding)?.saturating_sub(dev_bag);
    if st.coin_hold > 0 {
        let hold = st.coin_hold.min(free);
        let to_sol = u64::try_from(bps_of(u128::from(hold), LIQ_SOL_POOL_BPS)).unwrap_or(0);
        st.coin_for_sol = st.coin_for_sol.saturating_add(to_sol);
        st.coin_for_pair = st.coin_for_pair.saturating_add(hold - to_sol);
        let cost_sol = u64::try_from(bps_of(u128::from(st.pregrad_spent), LIQ_SOL_POOL_BPS)).unwrap_or(0);
        st.sol_leg = st.sol_leg.saturating_add(cost_sol);
        st.pair_leg = st.pair_leg.saturating_add(st.pregrad_spent - cost_sol);
        st.coin_hold = 0;
    }
    st.coin_for_sol = st.coin_for_sol.min(free);
    free -= st.coin_for_sol;
    st.coin_for_pair = st.coin_for_pair.min(free);

    // 1. Coin held for the launch pool: add it with pot SOL. With no SOL to put beside it, the
    // pair goes on (its adds need none).
    if value(st.coin_for_sol, coin_price) >= DUST_LAMPORTS {
        match add_sol_pool(s, st, &launch_pool, coin_price, coin_reference)? {
            Next::Idle(idle::POT) | Next::Idle(idle::TOO_SMALL) => {}
            next => return Ok(next),
        }
    } else {
        // Dust: to the pair.
        st.coin_for_pair = st.coin_for_pair.saturating_add(st.coin_for_sol);
        st.coin_for_sol = 0;
    }

    // The launch pool's side is due when it has had no more of the pot than its share.
    let sol_due = u128::from(st.sol_leg) * (BPS - LIQ_SOL_POOL_BPS)
        <= u128::from(st.pair_leg) * LIQ_SOL_POOL_BPS;

    // 2. The pair, once the wBORDR/SOL pool exists.
    let wpool = match PoolView::read(s.needs(&WBORDR_SOL_POOL)?) {
        Some(p)
            if p.base_mint == WBORDR_MINT
                && p.quote_mint == BRIDGED_SOL_MINT
                && p.hook_program.is_none()
                && p.native()
                && !p.curve =>
        {
            p
        }
        // No wBORDR/SOL pool: the pot goes on to the launch pool.
        _ => {
            msg!("pair blocked ({})", idle::NO_WBORDR_POOL);
            return buy_for_sol_pool(s, st, &launch_pool, coin_price, coin_reference);
        }
    };
    let wbordr_price = wpool.price();
    let wbordr_reference = observe(
        &mut st.wbordr_reference,
        &mut st.wbordr_price,
        &mut st.wbordr_moved_at,
        wbordr_price,
        s.now,
    );
    seen.new_reference |= wbordr_reference == 0;
    st.wbordr_held = st.wbordr_held.min(s.balance(&s.wbordr_holding)?);
    let (coin, wbordr) = (st.coin_for_pair, st.wbordr_held);
    let coin_value = value(coin, coin_price);
    let wbordr_value = value(wbordr, wbordr_price);
    let pair_open = coin_value >= DUST_LAMPORTS || wbordr_value >= DUST_LAMPORTS;
    let mut blocked = None;
    if coin_value >= DUST_LAMPORTS && wbordr_value >= DUST_LAMPORTS {
        if strays(coin_price, coin_reference) || strays(wbordr_price, wbordr_reference) {
            return Ok(Next::Idle(idle::STRAYS));
        }
        let Some(implied) = implied_price(coin_price, wbordr_price) else {
            return Ok(Next::Idle(idle::TOO_SMALL));
        };
        let keys = PairKeys::of(s);
        match add_pair(s, st, &config, &keys, implied, coin, wbordr)? {
            Next::Idle(idle::TOO_SMALL) => {}
            // The pair pool off the implied price: traded back to it, or (when the script holds
            // nothing that does) left, and the pot goes on to the launch pool.
            Next::Idle(idle::STRAYS) => match heal_pair(s, st, &keys, implied, coin, wbordr)? {
                Some(next) => return Ok(next),
                None => blocked = Some(idle::STRAYS),
            },
            Next::Idle(idle::ACCOUNTS) => blocked = Some(idle::ACCOUNTS),
            next => return Ok(next),
        }
    }
    if let Some(reason) = blocked {
        msg!("pair blocked ({})", reason);
        return buy_for_sol_pool(s, st, &launch_pool, coin_price, coin_reference);
    }
    // 3. Buy for a pool: the pair's lacking side while the pair is open, else the pool that has
    // had less of the pot.
    if pair_open || !sol_due {
        if wbordr_value <= coin_value {
            let spend = budget(s.spendable(), wpool.quote_depth(), coin_value - wbordr_value);
            if spend == 0 {
                return Ok(Next::Idle(idle::POT));
            }
            if above(wbordr_price, wbordr_reference) {
                return Ok(Next::Idle(idle::PRICE_ABOVE_REFERENCE));
            }
            return buy_wbordr(s, st, &wpool, spend);
        }
        let spend = budget(s.spendable(), launch_pool.quote_depth(), wbordr_value - coin_value);
        if spend == 0 {
            return Ok(Next::Idle(idle::POT));
        }
        if above(coin_price, coin_reference) {
            return Ok(Next::Idle(idle::PRICE_ABOVE_REFERENCE));
        }
        return buy_coin(s, st, &launch_pool, spend, Leg::Pair);
    }
    buy_for_sol_pool(s, st, &launch_pool, coin_price, coin_reference)
}

/// A coin buy for the launch pool (coin/SOL), unless the pot has nothing for it or its price runs
/// above the reference.
fn buy_for_sol_pool(s: &Step, st: &mut PairState, pool: &PoolView, coin_price: u128, coin_reference: u128) -> Result<Next> {
    let spend = budget(s.spendable(), pool.quote_depth(), 0);
    if spend == 0 {
        return Ok(Next::Idle(idle::POT));
    }
    if above(coin_price, coin_reference) {
        return Ok(Next::Idle(idle::PRICE_ABOVE_REFERENCE));
    }
    buy_coin(s, st, pool, spend, Leg::SolPool)
}

/// The launch-pool buy of `work` lamports by the companion address, with its minimum output.
fn launch_buy(s: &Step, pool: &PoolView, work: u64) -> Option<Instruction> {
    let least = min_out(pool, work, launch_buy_fee_bps(s.launch, s.now));
    if least == 0 {
        return None;
    }
    Some(launch_client::swap_v2_with_base_slice(
        &LaunchKeys::of(s.launch),
        s.creator,
        s.creator,
        1,
        work,
        least,
        s.slice.clone(),
    ))
}

/// A launch-pool buy of `spend`: the coin it bought (`None` when too small to quote).
fn launch_buy_got(s: &Step, pool: &PoolView, spend: u64) -> Result<Option<u64>> {
    let Some(buy) = launch_buy(s, pool, spend) else {
        return Ok(None);
    };
    let before = s.balance(&s.coin_holding)?;
    s.call(&buy)?;
    Ok(Some(s.balance(&s.coin_holding)?.saturating_sub(before)))
}

/// A dip: buy the coin with pot SOL for the liquidity (cheaply, at the dip): on the curve it is
/// held with the rest, after graduation half for each pool.
fn dip_buy(s: &Step, st: &mut PairState, pool: &PoolView, graduated: bool) -> Result<Next> {
    let mut spendable = s.spendable();
    if !graduated {
        spendable = spendable.min(pregrad_room(s.companion.map_or(0, |c| c.pot), st.pregrad_spent));
    }
    let spend = budget(spendable, pool.quote_depth(), 0);
    if spend == 0 {
        return Ok(Next::Idle(idle::POT));
    }
    let Some(bought) = launch_buy_got(s, pool, spend)? else {
        return Ok(Next::Idle(idle::TOO_SMALL));
    };
    if graduated {
        let to_sol = u64::try_from(bps_of(u128::from(bought), LIQ_SOL_POOL_BPS)).unwrap_or(0);
        st.coin_for_sol = st.coin_for_sol.saturating_add(to_sol);
        st.coin_for_pair = st.coin_for_pair.saturating_add(bought - to_sol);
        let cost_sol = u64::try_from(bps_of(u128::from(spend), LIQ_SOL_POOL_BPS)).unwrap_or(0);
        st.sol_leg = st.sol_leg.saturating_add(cost_sol);
        st.pair_leg = st.pair_leg.saturating_add(spend - cost_sol);
    } else {
        st.coin_hold = st.coin_hold.saturating_add(bought);
        st.pregrad_spent = st.pregrad_spent.saturating_add(spend);
    }
    st.sol_to_dip = st.sol_to_dip.saturating_add(spend);
    st.dip_bought = st.dip_bought.saturating_add(bought);
    Ok(Next::Done(Outcome {
        action: action::DIP_BUY,
        sol: spend,
        amount: bought,
    }))
}

/// Which pool a coin buy is for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Leg {
    /// On the curve: held for both pools after graduation.
    Hold,
    /// For the launch pool (coin/SOL).
    SolPool,
    /// For the coin/wBORDR pool.
    Pair,
}

/// Buy the coin on the launch pool (on the curve or after it) for `leg`, with `spend` of the pot.
fn buy_coin(s: &Step, st: &mut PairState, pool: &PoolView, spend: u64, leg: Leg) -> Result<Next> {
    if spend == 0 {
        return Ok(Next::Idle(idle::POT));
    }
    let Some(bought) = launch_buy_got(s, pool, spend)? else {
        return Ok(Next::Idle(idle::TOO_SMALL));
    };
    match leg {
        Leg::Hold => {
            st.coin_hold = st.coin_hold.saturating_add(bought);
            st.pregrad_spent = st.pregrad_spent.saturating_add(spend);
        }
        Leg::SolPool => {
            st.coin_for_sol = st.coin_for_sol.saturating_add(bought);
            st.sol_leg = st.sol_leg.saturating_add(spend);
        }
        Leg::Pair => {
            st.coin_for_pair = st.coin_for_pair.saturating_add(bought);
            st.pair_leg = st.pair_leg.saturating_add(spend);
        }
    }
    Ok(Next::Done(Outcome {
        action: if leg == Leg::Hold { action::HOLD } else { action::BUY_COIN },
        sol: spend,
        amount: bought,
    }))
}

/// Buy wBORDR for the pair on the wBORDR/SOL pool with `spend` of the pot (its holding made first,
/// from the pot, when the companion address has none).
fn buy_wbordr(s: &Step, st: &mut PairState, pool: &PoolView, spend: u64) -> Result<Next> {
    let info = s.needs(&s.wbordr_holding)?;
    let missing = info.owner != &TOKEN_PROGRAM;
    let rent = if missing {
        Rent::get()?.minimum_balance(Holding::LEN)
    } else {
        0
    };
    let spend = spend.min(s.spendable().saturating_sub(rent));
    if spend < MIN_SPEND_LAMPORTS {
        return Ok(Next::Idle(idle::POT));
    }
    let fee = u128::from(pool.lp_fee_bps) + u128::from(pool.protocol_fee_bps);
    let least = min_out(pool, spend, fee);
    if least == 0 {
        return Ok(Next::Idle(idle::TOO_SMALL));
    }
    let before = amount_of(info);
    if missing {
        s.call(&token_client::create_holding(s.creator, WBORDR_MINT, s.creator))?;
    }
    s.call(&dex::swap_v2_buy(s.creator, s.wbordr_holding, spend, least)?)?;
    let got = amount_of(info).saturating_sub(before);
    st.wbordr_held = st.wbordr_held.saturating_add(got);
    st.pair_leg = st.pair_leg.saturating_add(spend);
    Ok(Next::Done(Outcome {
        action: action::BUY_WBORDR,
        sol: spend,
        amount: got,
    }))
}

/// Add the coin held for the launch pool with pot SOL at the pool's ratio (wrapped for the pool's
/// buffer, as its `add_liquidity` takes it), the LP minted straight into the launch's holding;
/// any SOL left wrapped is unwrapped back into the pot.
fn add_sol_pool(s: &Step, st: &mut PairState, pool: &PoolView, coin_price: u128, coin_reference: u128) -> Result<Next> {
    if pool.curve || !pool.native() {
        return err!(ScriptError::WrongAccount);
    }
    let (br, qr) = (u128::from(pool.base_reserve), u128::from(pool.quote_reserve));
    if br == 0 || qr == 0 {
        return Ok(Next::Idle(idle::TOO_SMALL));
    }
    // What the pot may put in this step.
    let outlay = budget(s.spendable(), pool.quote_depth(), 0);
    if outlay == 0 {
        return Ok(Next::Idle(idle::POT));
    }
    if strays(coin_price, coin_reference) {
        return Ok(Next::Idle(idle::STRAYS));
    }
    let mut coin = u128::from(st.coin_for_sol);
    let mut sol = (coin * qr).div_ceil(br);
    if sol > u128::from(outlay) {
        coin = u128::from(outlay) * br / qr;
        sol = (coin * qr).div_ceil(br);
    }
    let (coin, sol) = (u64::try_from(coin).unwrap_or(0), u64::try_from(sol).unwrap_or(0));
    if coin == 0 || sol == 0 {
        return Ok(Next::Idle(idle::POT));
    }
    let Some((_, sol_used, lp)) =
        dex::lp_for_deposit(coin, sol, pool.base_reserve, pool.quote_reserve, pool.lp_supply)
    else {
        return Ok(Next::Idle(idle::TOO_SMALL));
    };
    let min_lp = u64::try_from(bps_of(u128::from(lp), BPS - SLIPPAGE_BPS)).unwrap_or(0);
    let wrapped = token_client::holding_address(&BRIDGED_SOL_MINT, &s.creator);
    let add = dex::add_liquidity(
        s.creator,
        s.launch.pool,
        s.mint,
        BRIDGED_SOL_MINT,
        Some((bordrless_launch::ID, dex::LAUNCH_HOOK_SIGNER)),
        s.coin_holding,
        wrapped,
        s.launch_lp,
        coin,
        sol_used,
        min_lp,
        s.slice.clone(),
        launch_client::hook_extras(&s.mint, &BRIDGED_SOL_MINT),
    )?;
    let lock = s.needs(&s.launch_lp)?;
    let lp_before = amount_of(lock);
    let coin_before = s.balance(&s.coin_holding)?;
    let wrapped_before = s.balance(&wrapped)?;
    s.call(&dex::bridge_sol(s.creator, wrapped, sol_used, false)?)?;
    s.call(&add)?;
    // Whatever the pool didn't take goes back into the pot.
    let left = s.balance(&wrapped)?.saturating_sub(wrapped_before);
    if left > 0 {
        s.call(&dex::bridge_sol(s.creator, wrapped, left, true)?)?;
    }
    let used = coin_before.saturating_sub(s.balance(&s.coin_holding)?);
    let got = amount_of(lock).saturating_sub(lp_before);
    let spent = sol_used.saturating_sub(left);
    st.coin_for_sol = st.coin_for_sol.saturating_sub(used);
    st.sol_leg = st.sol_leg.saturating_add(spent);
    st.sol_pool_lp_locked = st.sol_pool_lp_locked.saturating_add(got);
    Ok(Next::Done(Outcome {
        action: action::ADD_SOL_POOL,
        sol: spent,
        amount: got,
    }))
}

/// Put `coin` and `wbordr` (what the script holds for the pair) into the coin/wBORDR pool,
/// creating it at `implied` the first time, then lock every LP it got in the launch's holding of
/// the LP mint.
#[allow(clippy::too_many_arguments)]
fn add_pair(
    s: &Step,
    st: &mut PairState,
    config: &DexConfigView,
    k: &PairKeys,
    implied: u128,
    coin: u64,
    wbordr: u64,
) -> Result<Next> {
    let pool_info = s.needs(&k.pool)?;
    let launch_lp_info = s.needs(&k.launch_lp)?;
    let creator_lp_info = s.needs(&k.creator_lp)?;
    let holding_rent = Rent::get()?.minimum_balance(Holding::LEN);
    let lock_rent = if launch_lp_info.owner == &TOKEN_PROGRAM { 0 } else { holding_rent };
    let creator_lp_missing = creator_lp_info.owner != &TOKEN_PROGRAM;
    let created = pool_info.owner == &SWAP_PROGRAM;
    let (ix, kind) = if !created {
        // The first add creates the pool: as much of both as matches the implied price.
        let quote_for_coin = value(coin, implied);
        let (base, quote) = if quote_for_coin <= u128::from(wbordr) {
            (coin, u64::try_from(quote_for_coin).unwrap_or(0))
        } else {
            let base = (u128::from(wbordr) << PRICE_SHIFT) / implied;
            (u64::try_from(base).unwrap_or(0).min(coin), wbordr)
        };
        if base == 0 || quote == 0 || dex::initial_lp(base, quote).is_none() {
            return Ok(Next::Idle(idle::TOO_SMALL));
        }
        let rent = POOL_RENT_LAMPORTS.saturating_add(config.creation_fee).saturating_add(lock_rent);
        if s.spendable() < rent {
            return Ok(Next::Idle(idle::POT));
        }
        let ix = dex::create_pool(
            s.creator,
            config.treasury,
            s.mint,
            WBORDR_MINT,
            PAIR_LP_FEE_BPS,
            s.coin_holding,
            s.wbordr_holding,
            k.creator_lp,
            base,
            quote,
            s.slice.clone(),
        )?;
        (ix, action::CREATE_PAIR)
    } else {
        let Some(pool) = PoolView::read(pool_info).filter(|p| {
            p.base_mint == s.mint && p.quote_mint == WBORDR_MINT && p.hook_program.is_none() && !p.curve
        }) else {
            return err!(ScriptError::WrongAccount);
        };
        if strays(pool.price(), implied) {
            return Ok(Next::Idle(idle::STRAYS));
        }
        let Some((_, _, lp)) =
            dex::lp_for_deposit(coin, wbordr, pool.base_reserve, pool.quote_reserve, pool.lp_supply)
        else {
            return Ok(Next::Idle(idle::TOO_SMALL));
        };
        let creator_rent = if creator_lp_missing { holding_rent } else { 0 };
        if s.spendable() < lock_rent.saturating_add(creator_rent) {
            return Ok(Next::Idle(idle::POT));
        }
        let min_lp = u64::try_from(bps_of(u128::from(lp), BPS - SLIPPAGE_BPS)).unwrap_or(0);
        let ix = dex::add_liquidity(
            s.creator,
            k.pool,
            s.mint,
            WBORDR_MINT,
            None,
            s.coin_holding,
            s.wbordr_holding,
            k.creator_lp,
            coin,
            wbordr,
            min_lp,
            s.slice.clone(),
            vec![],
        )?;
        (ix, action::ADD_PAIR)
    };
    // Creating the pool also writes the DEX's config and pays its treasury: keeper.json's pools
    // name neither for sure, so a step without them is idle rather than failed.
    if !s.ready(&ix, &[DEX_CONFIG, config.treasury])? {
        return Ok(Next::Idle(idle::ACCOUNTS));
    }
    let coin_before = s.balance(&s.coin_holding)?;
    let wbordr_before = s.balance(&s.wbordr_holding)?;
    // `create_pool` makes the companion address's LP holding itself; an add needs it first.
    if created && creator_lp_missing {
        s.call(&token_client::create_holding(s.creator, k.lp_mint, s.creator))?;
    }
    s.call(&ix)?;
    let coin_used = coin_before.saturating_sub(s.balance(&s.coin_holding)?);
    let wbordr_used = wbordr_before.saturating_sub(s.balance(&s.wbordr_holding)?);
    // Every LP the companion address holds of this pool is the script's: all of it to the lock.
    let lp = amount_of(creator_lp_info);
    if launch_lp_info.owner != &TOKEN_PROGRAM {
        s.call(&token_client::create_holding(s.creator, k.lp_mint, s.launch_key))?;
    }
    if lp > 0 {
        s.call(&token_client::transfer_with(s.creator, k.creator_lp, k.launch_lp, k.lp_mint, None, vec![], lp))?;
    }
    st.coin_for_pair = st.coin_for_pair.saturating_sub(coin_used);
    st.wbordr_held = st.wbordr_held.saturating_sub(wbordr_used);
    st.pair_lp_locked = st.pair_lp_locked.saturating_add(lp);
    Ok(Next::Done(Outcome {
        action: kind,
        sol: 0,
        amount: lp,
    }))
}

/// Trade the coin/wBORDR pool back to `implied` with what the script holds for it (`coin` and
/// `wbordr`): coin into it while it prices the coin above `implied`, wBORDR while below, as much as
/// brings a constant-product pool to `implied` (fees aside), at most what is held. The pot buys the
/// cheap side. `None` when it can't: no such pool, nothing held of the side that heals, a price
/// out of range.
fn heal_pair(s: &Step, st: &mut PairState, k: &PairKeys, implied: u128, coin: u64, wbordr: u64) -> Result<Option<Next>> {
    let Some(pool) = PoolView::read(s.needs(&k.pool)?).filter(|p| {
        p.base_mint == s.mint && p.quote_mint == WBORDR_MINT && p.hook_program.is_none() && !p.curve
    }) else {
        return Ok(None);
    };
    let (br, qr) = (u128::from(pool.base_reserve), u128::from(pool.quote_reserve));
    let price = pool.price();
    if br == 0 || qr == 0 || price == 0 || implied == 0 {
        return Ok(None);
    }
    // Selling the coin grows the base side, buying it the quote side, each by sqrt(dear / cheap).
    let sell = price > implied;
    let (dear, cheap, side, held) = if sell { (price, implied, br, coin) } else { (implied, price, qr, wbordr) };
    let shifted = |v: u128| v.checked_shl(PRICE_SHIFT).filter(|w| w >> PRICE_SHIFT == v);
    let Some(root) = shifted(dear).map(|v| v / cheap).and_then(shifted).map(dex::isqrt) else {
        return Ok(None);
    };
    let Some(target) = side.checked_mul(root).map(|v| v >> PRICE_SHIFT) else {
        return Ok(None);
    };
    let amount = u64::try_from(target.saturating_sub(side).min(u128::from(held))).unwrap_or(0);
    if amount == 0 {
        return Ok(None);
    }
    let fee = u128::from(pool.lp_fee_bps) + u128::from(pool.protocol_fee_bps);
    let net = bps_of(u128::from(amount), BPS.saturating_sub(fee));
    let (into, out) = if sell { (br, qr) } else { (qr, br) };
    let least = u64::try_from(bps_of(out * net / (into + net), BPS - SLIPPAGE_BPS)).unwrap_or(0);
    if least == 0 {
        return Ok(None);
    }
    let ix = dex::swap(
        s.creator,
        k.pool,
        s.mint,
        WBORDR_MINT,
        s.coin_holding,
        s.wbordr_holding,
        u8::from(!sell),
        amount,
        least,
        s.slice.clone(),
    )?;
    let coin_before = s.balance(&s.coin_holding)?;
    let wbordr_before = s.balance(&s.wbordr_holding)?;
    s.call(&ix)?;
    let coin_after = s.balance(&s.coin_holding)?;
    let wbordr_after = s.balance(&s.wbordr_holding)?;
    st.coin_for_pair = st
        .coin_for_pair
        .saturating_sub(coin_before.saturating_sub(coin_after))
        .saturating_add(coin_after.saturating_sub(coin_before));
    st.wbordr_held = st
        .wbordr_held
        .saturating_sub(wbordr_before.saturating_sub(wbordr_after))
        .saturating_add(wbordr_after.saturating_sub(wbordr_before));
    Ok(Some(Next::Done(Outcome {
        action: action::HEAL_PAIR,
        sol: 0,
        amount,
    })))
}
