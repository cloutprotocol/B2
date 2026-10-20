//! The accounts of other programs this script reads, by their published layouts: the hook half's
//! state, the companion, the DEX's config and pools, and the Bordrless token's holdings and mints
//! (the last through `bordrless_token::client`). Each read checks the account's owner and its
//! Anchor discriminator first, and answers `None` for anything else, so a wrong account is never
//! read as a right one.

use anchor_lang::prelude::*;
use bordrless_token::client as token_client;

use crate::{COMPANION_PROGRAM, PRICE_SHIFT, SWAP_PROGRAM, TOKEN_PROGRAM};

/// `sha256("account:DipState")[..8]`: the hook half's state.
pub const DIP_STATE_DISCRIMINATOR: [u8; 8] = [0xab, 0x08, 0xcf, 0x8f, 0xba, 0x81, 0xa9, 0xb6];
/// `sha256("account:Companion")[..8]`.
pub const COMPANION_DISCRIMINATOR: [u8; 8] = [189, 21, 247, 69, 245, 100, 10, 15];
/// `sha256("account:Config")[..8]`: the DEX's config.
pub const DEX_CONFIG_DISCRIMINATOR: [u8; 8] = [155, 12, 170, 224, 30, 250, 204, 130];
/// `sha256("account:Pool")[..8]`: a DEX pool.
pub const POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];

/// The hook half's state (`DipState`), by byte offset (the hook's module docs hold the same table):
/// the mint at 10, the reference price (u128) at 42, the dip flag at 82, when the dip began at 83.
pub mod dip_state {
    /// The mint.
    pub const MINT: usize = 10;
    /// The reference price, u128 LE, 2^48 fixed point.
    pub const REFERENCE: usize = 42;
    /// 1 while the last trade saw a dip.
    pub const DIP: usize = 82;
    /// When the current dip began, i64 LE (0 outside one).
    pub const DIP_SINCE: usize = 83;
    /// Bytes up to and including when the dip began.
    pub const END: usize = 91;
}

/// The companion (`bordrless_companion::state::Companion`), by byte offset: the dev bag (bought,
/// released) at 116 and 124, the pot (`pending_pot`) at 270.
pub mod companion {
    /// `dev_tokens`, u64 LE: the dev bag bought.
    pub const DEV_TOKENS: usize = 116;
    /// `dev_released`, u64 LE: the dev bag released so far.
    pub const DEV_RELEASED: usize = 124;
    /// `pending_pot`, u64 LE: the pot, what a step may spend.
    pub const PENDING_POT: usize = 270;
    /// Bytes up to and including the pot.
    pub const END: usize = 278;
}

/// The DEX's config (`bordrless_swap::state::Config`), by byte offset: its treasury at 76, the
/// pool creation fee at 108 and the pause at 116.
pub mod dex_config {
    /// `treasury`: receives the pool creation fee.
    pub const TREASURY: usize = 76;
    /// `pool_creation_fee_lamports`, u64 LE.
    pub const CREATION_FEE: usize = 108;
    /// `paused`: stops swaps and liquidity changes.
    pub const PAUSED: usize = 116;
    /// Bytes up to and including the pause.
    pub const END: usize = 117;
}

/// The data of `info` when `owner` owns it and it starts with `discriminator` and holds `len` bytes.
fn data_of<'a>(
    info: &'a AccountInfo,
    owner: &Pubkey,
    discriminator: &[u8; 8],
    len: usize,
) -> Option<std::cell::Ref<'a, &'a mut [u8]>> {
    if info.owner != owner {
        return None;
    }
    let data = info.try_borrow_data().ok()?;
    if data.len() < len || data[..8] != discriminator[..] {
        return None;
    }
    Some(data)
}

fn u64_at(data: &[u8], at: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[at..at + 8]);
    u64::from_le_bytes(b)
}

fn u128_at(data: &[u8], at: usize) -> u128 {
    let mut b = [0u8; 16];
    b.copy_from_slice(&data[at..at + 16]);
    u128::from_le_bytes(b)
}

fn key_at(data: &[u8], at: usize) -> Pubkey {
    let mut b = [0u8; 32];
    b.copy_from_slice(&data[at..at + 32]);
    Pubkey::new_from_array(b)
}

/// What the script reads of the hook half's state.
#[derive(Clone, Copy, Debug)]
pub struct DipView {
    /// The hook's reference price.
    pub reference: u128,
    /// Whether the last trade saw a dip.
    pub dip: bool,
    /// When the current dip began (0 outside one).
    pub dip_since: i64,
}

/// The hook half's state for `mint`, at `info` (which the caller found at `PDA(["state", mint],
/// hook)`): owned by `hook` (the mint's hook program), a `DipState` of this mint.
pub fn read_dip_state(info: &AccountInfo, hook: &Pubkey, mint: &Pubkey) -> Option<DipView> {
    let data = data_of(info, hook, &DIP_STATE_DISCRIMINATOR, dip_state::END)?;
    if key_at(&data, dip_state::MINT) != *mint {
        return None;
    }
    Some(DipView {
        reference: u128_at(&data, dip_state::REFERENCE),
        dip: data[dip_state::DIP] == 1,
        dip_since: i64::from_le_bytes(u64_at(&data, dip_state::DIP_SINCE).to_le_bytes()),
    })
}

/// What the script reads of the companion: the pot and the dev bag still held.
#[derive(Clone, Copy, Debug)]
pub struct CompanionView {
    /// `pending_pot`: the most a step may spend.
    pub pot: u64,
    /// The dev bag not yet released, in the companion address's token holding.
    pub dev_bag: u64,
}

/// The companion at `info` (its address is checked by the step's accounts).
pub fn read_companion(info: &AccountInfo) -> Option<CompanionView> {
    let data = data_of(info, &COMPANION_PROGRAM, &COMPANION_DISCRIMINATOR, companion::END)?;
    Some(CompanionView {
        pot: u64_at(&data, companion::PENDING_POT),
        dev_bag: u64_at(&data, companion::DEV_TOKENS)
            .saturating_sub(u64_at(&data, companion::DEV_RELEASED)),
    })
}

/// What the script reads of the DEX's config.
#[derive(Clone, Copy, Debug)]
pub struct DexConfigView {
    /// Receives the pool creation fee.
    pub treasury: Pubkey,
    /// The pool creation fee, lamports.
    pub creation_fee: u64,
    /// Swaps and liquidity changes stopped.
    pub paused: bool,
}

/// The DEX's config at `info` (its address is checked by the caller).
pub fn read_dex_config(info: &AccountInfo) -> Option<DexConfigView> {
    let data = data_of(info, &SWAP_PROGRAM, &DEX_CONFIG_DISCRIMINATOR, dex_config::END)?;
    Some(DexConfigView {
        treasury: key_at(&data, dex_config::TREASURY),
        creation_fee: u64_at(&data, dex_config::CREATION_FEE),
        paused: data[dex_config::PAUSED] != 0,
    })
}

/// A DEX pool (`bordrless_swap::state::Pool`), its fields in order up to what the script reads.
#[derive(AnchorDeserialize, Clone, Debug)]
pub struct PoolView {
    pub version: u8,
    pub bump: u8,
    pub lp_mint_bump: u8,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub lp_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub hook_program: Option<Pubkey>,
    pub hook_flags: u16,
    pub lp_fee_bps: u16,
    pub protocol_fee_bps: u16,
    pub base_reserve: u64,
    pub quote_reserve: u64,
    pub virtual_base: u64,
    pub virtual_quote: u64,
    pub lp_supply: u64,
    pub protocol_fees_quote: u64,
    pub curve: bool,
    pub creator: Pubkey,
    pub created_at: i64,
    pub last_swap_at: i64,
    pub swap_count: u64,
    pub base_volume: u128,
    pub quote_volume: u128,
    pub hook_signer_bump: u8,
    pub fee_model: u8,
    pub protocol_share_bps: u16,
    /// `reserved[0]` is 1 for a native pool (its quote is lamports on the pool).
    pub reserved: [u8; 60],
}

impl PoolView {
    /// The pool at `info`: owned by the DEX, a `Pool`.
    pub fn read(info: &AccountInfo) -> Option<Self> {
        let data = data_of(info, &SWAP_PROGRAM, &POOL_DISCRIMINATOR, 8)?;
        Self::deserialize(&mut &data[8..]).ok()
    }

    /// Whether its quote is native SOL (lamports on the pool).
    pub fn native(&self) -> bool {
        self.reserved[0] == 1
    }

    /// Its price: quote per base, virtual offsets included, 2^48 fixed point (the hook's).
    pub fn price(&self) -> u128 {
        price(self.base_reserve, self.virtual_base, self.quote_reserve, self.virtual_quote)
    }

    /// Its quote side, virtual offset included: what a buy's 1% of depth is taken of.
    pub fn quote_depth(&self) -> u128 {
        u128::from(self.quote_reserve) + u128::from(self.virtual_quote)
    }

    /// What `amount_in` of quote buys of base at its reserves, before any fee (constant product
    /// on the virtual reserves), never more than its real base.
    pub fn quote_out(&self, amount_in: u64) -> u64 {
        let base = u128::from(self.base_reserve) + u128::from(self.virtual_base);
        let quote = self.quote_depth();
        let out = base * u128::from(amount_in) / (quote + u128::from(amount_in)).max(1);
        u64::try_from(out.min(u128::from(self.base_reserve))).unwrap_or(0)
    }
}

/// A price from reserves and virtual offsets: quote per base, 2^48 fixed point; 0 for an empty
/// base side (the hook half's `price`).
pub fn price(base_reserve: u64, virtual_base: u64, quote_reserve: u64, virtual_quote: u64) -> u128 {
    let base = u128::from(base_reserve) + u128::from(virtual_base);
    let quote = u128::from(quote_reserve) + u128::from(virtual_quote);
    if base == 0 {
        return 0;
    }
    (quote << PRICE_SHIFT) / base
}

/// The balance of the holding at `info` (0 while it doesn't exist). The caller found `info` at a
/// holding address it derived itself, `PDA(["holding", mint, owner], token program)`, and only the
/// token program writes there, so the key is not derived again.
pub fn amount_of(info: &AccountInfo) -> u64 {
    if info.owner != &TOKEN_PROGRAM {
        return 0;
    }
    token_client::read_holding(info).map_or(0, |h| h.amount)
}
