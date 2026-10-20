//! The Bordrless DEX and bridge instructions this script sends that its template's crates don't
//! build: a `swap_v2` buy on an ordinary native pool (wBORDR/SOL), a classic `swap` (coin/wBORDR,
//! to bring it back to the SOL pools' price), `create_pool` (coin/wBORDR),
//! `add_liquidity` (coin/wBORDR, and the launch pool), and the bridge's `wrap_sol` / `unwrap_sol`
//! (the launch pool's deposit takes bridged SOL into its buffer). Each is built as the DEX's own client builds it (`bordrless_swap::client`:
//! the accounts of each `Accounts` struct in order, an absent optional account as the DEX's id,
//! the event authority and the program last, then the token-hook slices), with Anchor's
//! discriminator and Borsh arguments. The tests check every builder against the DEX's client.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use bordrless_launch::constants::{DEX_CONFIG, DEX_EVENT_AUTHORITY, TOKEN_EVENT_AUTHORITY};
use bordrless_token::client as token_client;

use crate::{
    BRIDGE_PROGRAM, BRIDGED_SOL_MINT, SWAP_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, WBORDR_MINT,
    WBORDR_SOL_POOL,
};

/// `sha256("global:swap")[..8]`.
pub const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
/// `sha256("global:swap_v2")[..8]`.
pub const SWAP_V2_DISCRIMINATOR: [u8; 8] = [43, 4, 237, 11, 26, 201, 30, 98];
/// `sha256("global:create_pool")[..8]`.
pub const CREATE_POOL_DISCRIMINATOR: [u8; 8] = [233, 146, 209, 142, 207, 104, 64, 188];
/// `sha256("global:add_liquidity")[..8]`.
pub const ADD_LIQUIDITY_DISCRIMINATOR: [u8; 8] = [181, 157, 89, 67, 143, 182, 52, 72];
/// `sha256("global:wrap_sol")[..8]` (the bridge).
pub const WRAP_SOL_DISCRIMINATOR: [u8; 8] = [47, 62, 155, 172, 131, 205, 37, 201];
/// `sha256("global:unwrap_sol")[..8]` (the bridge).
pub const UNWRAP_SOL_DISCRIMINATOR: [u8; 8] = [99, 40, 14, 105, 45, 107, 172, 201];
/// Native SOL's SPL mint, the bridge's seed for bridged SOL's wrapper.
pub const NATIVE_MINT: Pubkey = Pubkey::from_str_const("So11111111111111111111111111111111111111112");
/// The bridge's config, `PDA(["config"], bridge)`.
pub const BRIDGE_CONFIG: Pubkey = Pubkey::from_str_const("Dwf4C8tTMYwicp8cU5MYcTtMQVVJTN7W3LcXCQ1UEhMs");
/// The bridge's wrapper of native SOL, `PDA(["wrapper", NATIVE_MINT], bridge)`.
pub const BRIDGE_SOL_WRAPPER: Pubkey = Pubkey::from_str_const("3ta59VvLDKLnCKMhYihiC3fQ7W9jPKty6xfx3h5puHGS");
/// The bridge's SOL vault, `PDA(["sol-vault"], bridge)`.
pub const BRIDGE_SOL_VAULT: Pubkey = Pubkey::from_str_const("EAcZR2i8A6BbnKRdWuyMVDTuiNkD6qc4RkFpxUYJ9Qba");
/// The bridge's event authority, `PDA(["__event_authority"], bridge)`.
pub const BRIDGE_EVENT_AUTHORITY: Pubkey = Pubkey::from_str_const("EiUK62AP8DwUJWBosf7Ceyih3sGAicZxmsmcBftHzM8n");
/// The DEX's signer of the launchpad's pool-hook callbacks, `PDA(["hook-authority", launchpad],
/// DEX)`: what an add to a launch pool passes.
pub const LAUNCH_HOOK_SIGNER: Pubkey = Pubkey::from_str_const("6Ztfr97cUewdViXDXdZUsQq4pz7MYdygvK1WijALjZ5q");
/// The wBORDR/SOL pool's wBORDR vault, `PDA(["holding", wBORDR, pool], token program)`.
pub const WBORDR_SOL_VAULT: Pubkey = Pubkey::from_str_const("BFejQCATMkPNxZ2sdGRf1h2gC125k4PFsAviVrE1bji2");
/// The LP the DEX keeps for ever in a new pool (`bordrless_core::policy::MINIMUM_LIQUIDITY`).
pub const MINIMUM_LIQUIDITY: u64 = 1_000;

/// `bordrless_swap::instructions::SwapArgs`.
#[derive(AnchorSerialize, Clone, Debug)]
pub struct SwapArgs {
    pub direction: u8,
    pub amount_in: u64,
    pub min_amount_out: u64,
    pub in_hook_accounts: u8,
    pub out_hook_accounts: u8,
    pub hook_data: Vec<u8>,
}

/// `bordrless_swap::instructions::CreatePoolArgs`.
#[derive(AnchorSerialize, Clone, Debug)]
pub struct CreatePoolArgs {
    pub lp_fee_bps: u16,
    pub hook_program: Pubkey,
    pub hook_flags: u16,
    pub virtual_base: u64,
    pub virtual_quote: u64,
    pub base_amount: u64,
    pub quote_amount: u64,
    pub base_hook_accounts: u8,
    pub quote_hook_accounts: u8,
    pub hook_data: Vec<u8>,
}

/// `bordrless_swap::instructions::AddLiquidityArgs`.
#[derive(AnchorSerialize, Clone, Debug)]
pub struct AddLiquidityArgs {
    pub base_desired: u64,
    pub quote_desired: u64,
    pub min_lp: u64,
    pub base_hook_accounts: u8,
    pub quote_hook_accounts: u8,
    pub hook_data: Vec<u8>,
}

/// The pool of `base`/`quote` at `lp_fee_bps` with no pool hook: `PDA(["pool", base, quote,
/// lp_fee_bps (u16 LE), default key], DEX)`.
pub fn pool_address(base: &Pubkey, quote: &Pubkey, lp_fee_bps: u16) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"pool",
            base.as_ref(),
            quote.as_ref(),
            &lp_fee_bps.to_le_bytes(),
            Pubkey::default().as_ref(),
        ],
        &SWAP_PROGRAM,
    )
    .0
}

/// A pool's LP mint: `PDA(["lp", pool], DEX)`.
pub fn lp_mint_address(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"lp", pool.as_ref()], &SWAP_PROGRAM).0
}

fn data<T: AnchorSerialize>(discriminator: [u8; 8], args: &T) -> Result<Vec<u8>> {
    let mut d = discriminator.to_vec();
    args.serialize(&mut d)?;
    Ok(d)
}

fn ro(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, false)
}

fn rw(key: Pubkey) -> AccountMeta {
    AccountMeta::new(key, false)
}

/// The DEX's id in an absent optional account's place.
fn absent() -> AccountMeta {
    ro(SWAP_PROGRAM)
}

/// The token program and its event authority, in the order every DEX instruction takes them.
fn token_fixed() -> [AccountMeta; 2] {
    [ro(TOKEN_PROGRAM), ro(TOKEN_EVENT_AUTHORITY)]
}

/// The DEX's event authority and the DEX (Anchor's `#[event_cpi]`).
fn events() -> [AccountMeta; 2] {
    [ro(DEX_EVENT_AUTHORITY), ro(SWAP_PROGRAM)]
}

/// A `swap_v2` buy of wBORDR on the wBORDR/SOL pool (native, no pool hook, no token hook) with
/// `amount_in` lamports from `trader`, delivered to its wBORDR holding `trader_base`.
pub fn swap_v2_buy(trader: Pubkey, trader_base: Pubkey, amount_in: u64, min_amount_out: u64) -> Result<Instruction> {
    let mut accounts = vec![
        AccountMeta::new(trader, true),
        ro(DEX_CONFIG),
        rw(WBORDR_SOL_POOL),
        ro(WBORDR_MINT),
        ro(BRIDGED_SOL_MINT),
        rw(WBORDR_SOL_VAULT),
        rw(trader_base),
        rw(trader),
        absent(),
        absent(),
    ];
    accounts.extend(token_fixed());
    accounts.push(ro(SYSTEM_PROGRAM));
    accounts.extend((0..5).map(|_| absent()));
    accounts.extend(events());
    Ok(Instruction {
        program_id: SWAP_PROGRAM,
        accounts,
        data: data(
            SWAP_V2_DISCRIMINATOR,
            &SwapArgs {
                direction: 1,
                amount_in,
                min_amount_out,
                in_hook_accounts: 0,
                out_hook_accounts: 0,
                hook_data: vec![],
            },
        )?,
    })
}

/// A classic `swap` on `pool` (`base`/`quote`, no pool hook) by `trader` from and to its holdings
/// `trader_base` and `trader_quote`: `direction` 0 sells base, 1 buys it; `base_slice` the base
/// mint's token-hook slice (the quote has none), placed as the input's or the output's.
#[allow(clippy::too_many_arguments)]
pub fn swap(
    trader: Pubkey,
    pool: Pubkey,
    base: Pubkey,
    quote: Pubkey,
    trader_base: Pubkey,
    trader_quote: Pubkey,
    direction: u8,
    amount_in: u64,
    min_amount_out: u64,
    base_slice: Vec<AccountMeta>,
) -> Result<Instruction> {
    let mut accounts = vec![
        AccountMeta::new(trader, true),
        ro(DEX_CONFIG),
        rw(pool),
        ro(base),
        ro(quote),
        rw(token_client::holding_address(&base, &pool)),
        rw(token_client::holding_address(&quote, &pool)),
        rw(trader_base),
        rw(trader_quote),
        absent(),
        absent(),
    ];
    accounts.extend(token_fixed());
    accounts.extend(events());
    let n = u8::try_from(base_slice.len()).unwrap_or(u8::MAX);
    let (in_hook_accounts, out_hook_accounts) = if direction == 0 { (n, 0) } else { (0, n) };
    accounts.extend(base_slice);
    Ok(Instruction {
        program_id: SWAP_PROGRAM,
        accounts,
        data: data(
            SWAP_DISCRIMINATOR,
            &SwapArgs {
                direction,
                amount_in,
                min_amount_out,
                in_hook_accounts,
                out_hook_accounts,
                hook_data: vec![],
            },
        )?,
    })
}

/// `create_pool` of `base`/`quote` at `lp_fee_bps` with no pool hook, `authority` depositing from
/// its holdings `authority_base` and `authority_quote` and paying (the companion address), the LP
/// to its holding `authority_lp`, `base_slice` the base mint's token-hook slice (the quote has
/// none).
#[allow(clippy::too_many_arguments)]
pub fn create_pool(
    authority: Pubkey,
    treasury: Pubkey,
    base: Pubkey,
    quote: Pubkey,
    lp_fee_bps: u16,
    authority_base: Pubkey,
    authority_quote: Pubkey,
    authority_lp: Pubkey,
    base_amount: u64,
    quote_amount: u64,
    base_slice: Vec<AccountMeta>,
) -> Result<Instruction> {
    let pool = pool_address(&base, &quote, lp_fee_bps);
    let lp_mint = lp_mint_address(&pool);
    let mut accounts = vec![
        AccountMeta::new(authority, true),
        AccountMeta::new_readonly(authority, true),
        rw(DEX_CONFIG),
        rw(treasury),
        ro(base),
        ro(quote),
        rw(pool),
        rw(lp_mint),
        rw(token_client::holding_address(&base, &pool)),
        rw(token_client::holding_address(&quote, &pool)),
        rw(authority_base),
        rw(authority_quote),
        rw(authority_lp),
        absent(),
        absent(),
        absent(),
    ];
    accounts.extend(token_fixed());
    accounts.push(ro(SYSTEM_PROGRAM));
    accounts.extend(events());
    let base_hook_accounts = u8::try_from(base_slice.len()).unwrap_or(u8::MAX);
    accounts.extend(base_slice);
    Ok(Instruction {
        program_id: SWAP_PROGRAM,
        accounts,
        data: data(
            CREATE_POOL_DISCRIMINATOR,
            &CreatePoolArgs {
                lp_fee_bps,
                hook_program: Pubkey::default(),
                hook_flags: 0,
                virtual_base: 0,
                virtual_quote: 0,
                base_amount,
                quote_amount,
                base_hook_accounts,
                quote_hook_accounts: 0,
                hook_data: vec![],
            },
        )?,
    })
}

/// `add_liquidity` to `pool` (`base`/`quote`, its pool hook and the DEX's signer of its callbacks
/// `hook`, none for coin/wBORDR) by `provider` from its holdings `provider_base` and
/// `provider_quote`, the LP minted into `provider_lp` (any holding of the LP mint: the launch's,
/// to lock it), `base_slice` the base mint's token-hook slice, `pool_extras` the pool hook's
/// extras.
#[allow(clippy::too_many_arguments)]
pub fn add_liquidity(
    provider: Pubkey,
    pool: Pubkey,
    base: Pubkey,
    quote: Pubkey,
    hook: Option<(Pubkey, Pubkey)>,
    provider_base: Pubkey,
    provider_quote: Pubkey,
    provider_lp: Pubkey,
    base_desired: u64,
    quote_desired: u64,
    min_lp: u64,
    base_slice: Vec<AccountMeta>,
    pool_extras: Vec<AccountMeta>,
) -> Result<Instruction> {
    let lp_mint = lp_mint_address(&pool);
    let mut accounts = vec![
        AccountMeta::new(provider, true),
        ro(DEX_CONFIG),
        rw(pool),
        ro(base),
        ro(quote),
        rw(lp_mint),
        rw(token_client::holding_address(&base, &pool)),
        rw(token_client::holding_address(&quote, &pool)),
        rw(provider_base),
        rw(provider_quote),
        rw(provider_lp),
        hook.map_or_else(absent, |(program, _)| ro(program)),
        hook.map_or_else(absent, |(_, signer)| ro(signer)),
    ];
    accounts.extend(token_fixed());
    accounts.extend(events());
    let base_hook_accounts = u8::try_from(base_slice.len()).unwrap_or(u8::MAX);
    accounts.extend(base_slice);
    accounts.extend(pool_extras);
    Ok(Instruction {
        program_id: SWAP_PROGRAM,
        accounts,
        data: data(
            ADD_LIQUIDITY_DISCRIMINATOR,
            &AddLiquidityArgs {
                base_desired,
                quote_desired,
                min_lp,
                base_hook_accounts,
                quote_hook_accounts: 0,
                hook_data: vec![],
            },
        )?,
    })
}

/// The bridge's `wrap_sol` (`unwrap` false: `lamports` of `user`'s SOL into its bridged-SOL
/// holding `user_holding`) or `unwrap_sol` (`unwrap` true: `lamports` of it back).
pub fn bridge_sol(user: Pubkey, user_holding: Pubkey, lamports: u64, unwrap: bool) -> Result<Instruction> {
    let mut accounts = vec![
        AccountMeta::new(user, true),
        ro(BRIDGE_CONFIG),
        rw(BRIDGE_SOL_WRAPPER),
        rw(BRIDGE_SOL_VAULT),
        rw(BRIDGED_SOL_MINT),
        rw(user_holding),
    ];
    accounts.extend(token_fixed());
    accounts.push(ro(SYSTEM_PROGRAM));
    accounts.push(ro(BRIDGE_EVENT_AUTHORITY));
    accounts.push(ro(BRIDGE_PROGRAM));
    let discriminator = if unwrap { UNWRAP_SOL_DISCRIMINATOR } else { WRAP_SOL_DISCRIMINATOR };
    Ok(Instruction {
        program_id: BRIDGE_PROGRAM,
        accounts,
        data: data(discriminator, &lamports)?,
    })
}

/// The integer square root of `n`, rounded down.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// The LP a new pool mints its depositor for `base` and `quote`, `None` when too small (the DEX's
/// `initial_lp`: the square root of their product less [`MINIMUM_LIQUIDITY`]).
pub fn initial_lp(base: u64, quote: u64) -> Option<u64> {
    let total = u64::try_from(isqrt(u128::from(base).checked_mul(u128::from(quote))?)).ok()?;
    total.checked_sub(MINIMUM_LIQUIDITY).filter(|lp| *lp > 0)
}

/// A later deposit at a pool's reserves (the DEX's `lp_for_deposit`): the base and quote taken at
/// the pool's ratio and the LP minted, `None` when a side is zero.
pub fn lp_for_deposit(
    base_desired: u64,
    quote_desired: u64,
    base_reserve: u64,
    quote_reserve: u64,
    lp_supply: u64,
) -> Option<(u64, u64, u64)> {
    if base_desired == 0 || quote_desired == 0 || base_reserve == 0 || quote_reserve == 0 || lp_supply == 0 {
        return None;
    }
    let (br, qr) = (u128::from(base_reserve), u128::from(quote_reserve));
    let ceil = |a: u128, b: u128, c: u128| a.checked_mul(b).map(|p| p.div_ceil(c));
    let quote_for_base = ceil(u128::from(base_desired), qr, br)?;
    let (base_used, quote_used) = if quote_for_base <= u128::from(quote_desired) {
        (u128::from(base_desired), quote_for_base)
    } else {
        (ceil(u128::from(quote_desired), br, qr)?, u128::from(quote_desired))
    };
    if base_used > u128::from(base_desired) {
        return None;
    }
    let lp_b = base_used.checked_mul(u128::from(lp_supply))? / br;
    let lp_q = quote_used.checked_mul(u128::from(lp_supply))? / qr;
    let lp = u64::try_from(lp_b.min(lp_q)).ok().filter(|lp| *lp > 0)?;
    Some((u64::try_from(base_used).ok()?, u64::try_from(quote_used).ok()?, lp))
}
