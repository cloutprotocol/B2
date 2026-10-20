import { type Connection, PublicKey } from '@solana/web3.js';
import {
  BRIDGE_PROGRAM,
  BRIDGED_SOL_MINT,
  LAUNCH_PROGRAM,
  SWAP_PROGRAM,
  decodeLaunch,
  decodeMint,
  decodePool,
  decodeWrapper,
  isNativePool,
  poolQuoteBooks,
  type Launch,
  type Mint,
  type Pool,
} from '@bordrless/sdk';

// The scanner's own read of the chain: every pool on the Bordrless DEX, every mint they trade and
// every launch, priced from the pools' books. Nothing here asks Bordrless's API; `enrich.ts` adds
// what only their indexer has (images, holders, 24 h volume).

const SOL = BRIDGED_SOL_MINT.toBase58();
const POOL_SIZE = 411;

export type PoolRow = {
  address: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  hookProgram: string | null;
  lpFeeBps: number;
  protocolFeeBps: number;
  curve: boolean;
  native: boolean;
  /** Real reserves in base units, as decimal strings. */
  baseReserve: string;
  quoteReserve: string;
  /** A curve's virtual reserves (0 for a pool), which price it with the real ones. */
  virtualBase: string;
  virtualQuote: string;
  /** Quote per whole base token, virtual reserves included (a curve's price). */
  price: number;
  /** Price in SOL per whole base token (via the quote's own SOL price when the quote isn't SOL). */
  priceSol: number | null;
  /** Both sides in SOL. */
  liquiditySol: number | null;
  createdAt: number;
  lastSwapAt: number;
  swapCount: number;
  /** Quote volume since creation, in whole quote tokens (the scanner's 24 h figure is a difference of these). */
  quoteVolume: number;
};

export type TokenRow = {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: number;
  hookProgram: string | null;
  creator: string;
  createdAt: number;
  /** The deepest pool by SOL liquidity: where the price comes from. */
  pool: string | null;
  pools: string[];
  priceSol: number | null;
  mcapSol: number | null;
  liquiditySol: number;
  /** Set for a bridged token: the SPL or Token-2022 mint it wraps 1:1, whose supply sets its market cap. */
  bridged: { underlying: string; wrapped: number } | null;
  /** Set for launchpad coins. */
  launch: { status: 'curve' | 'graduated'; progress: number; creatorFeeBps: number; graduatedAt: number } | null;
};

export type Market = {
  at: number;
  pools: PoolRow[];
  tokens: TokenRow[];
};

const whole = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;

/** Every pool account of the DEX, decoded. */
export async function fetchPools(conn: Connection): Promise<{ address: PublicKey; pool: Pool }[]> {
  const accounts = await conn.getProgramAccounts(SWAP_PROGRAM, { filters: [{ dataSize: POOL_SIZE }] });
  const out: { address: PublicKey; pool: Pool }[] = [];
  for (const a of accounts) {
    try {
      out.push({ address: a.pubkey, pool: decodePool(a.account.data) });
    } catch {
      // Another account of that size: not a pool.
    }
  }
  return out;
}

/** Every launch of the launchpad, by mint. */
export async function fetchLaunches(conn: Connection): Promise<Map<string, Launch>> {
  const accounts = await conn.getProgramAccounts(LAUNCH_PROGRAM);
  const out = new Map<string, Launch>();
  for (const a of accounts) {
    try {
      const l = decodeLaunch(a.account.data);
      out.set(l.mint.toBase58(), l);
    } catch {
      // Configs and the rest of the launchpad's accounts.
    }
  }
  return out;
}

export type Wrapped = { underlying: string; totalWrapped: bigint; underlyingSupply: number | null };

/** Every token the bridge wraps, by its wrapped mint, with the underlying mint's whole supply (for the market cap). */
export async function fetchWrapped(conn: Connection): Promise<Map<string, Wrapped>> {
  const accounts = await conn.getProgramAccounts(BRIDGE_PROGRAM);
  const out = new Map<string, Wrapped>();
  for (const a of accounts) {
    try {
      const w = decodeWrapper(a.account.data);
      if (w.native) continue; // SOL itself
      let underlyingSupply: number | null = null;
      try {
        underlyingSupply = (await conn.getTokenSupply(w.underlyingMint)).value.uiAmount;
      } catch {
        // Not an SPL or Token-2022 mint the RPC can read.
      }
      out.set(w.wrappedMint.toBase58(), { underlying: w.underlyingMint.toBase58(), totalWrapped: w.totalWrapped, underlyingSupply });
    } catch {
      // The bridge's config and other accounts.
    }
  }
  return out;
}

/** Mints by address, read 100 at a time. */
export async function fetchMints(conn: Connection, mints: string[]): Promise<Map<string, Mint>> {
  const out = new Map<string, Mint>();
  for (let i = 0; i < mints.length; i += 100) {
    const keys = mints.slice(i, i + 100).map((m) => new PublicKey(m));
    const infos = await conn.getMultipleAccountsInfo(keys);
    infos.forEach((info, j) => {
      if (!info) return;
      try {
        out.set(keys[j].toBase58(), decodeMint(info.data));
      } catch {
        // Not a mint of the standard.
      }
    });
  }
  return out;
}

/** Quote per whole base token from a pool's books, virtual reserves included. */
export function poolPrice(pool: Pool, baseDecimals: number, quoteDecimals: number): number {
  const base = pool.baseReserve + pool.virtualBase;
  if (base === 0n) return 0;
  const quote = pool.quoteReserve + pool.virtualQuote;
  return whole(quote, quoteDecimals) / whole(base, baseDecimals);
}

/** The market from raw accounts: pools priced in SOL (directly, or through their quote's deepest SOL pool), tokens by their deepest pool. */
export function buildMarket(
  raw: { address: PublicKey; pool: Pool }[],
  mints: Map<string, Mint>,
  launches: Map<string, Launch>,
  wrapped: Map<string, Wrapped> = new Map(),
): Market {
  const dec = (m: string) => mints.get(m)?.decimals ?? (m === SOL ? 9 : 6);

  // First pass: SOL-quoted pools give every base token a SOL price; the deepest pool wins.
  const solPrice = new Map<string, { price: number; depth: bigint }>([[SOL, { price: 1, depth: 1n << 62n }]]);
  for (const { pool } of raw) {
    if (pool.quoteMint.toBase58() !== SOL) continue;
    const base = pool.baseMint.toBase58();
    const depth = poolQuoteBooks(pool);
    const prev = solPrice.get(base);
    if (!prev || depth > prev.depth) solPrice.set(base, { price: poolPrice(pool, dec(base), 9), depth });
  }

  const pools: PoolRow[] = raw.map(({ address, pool }) => {
    const base = pool.baseMint.toBase58();
    const quote = pool.quoteMint.toBase58();
    const price = poolPrice(pool, dec(base), dec(quote));
    const quoteSol = solPrice.get(quote)?.price ?? null;
    const quoteSide = whole(poolQuoteBooks(pool), dec(quote));
    const baseSide = whole(pool.baseReserve, dec(base));
    return {
      address: address.toBase58(),
      baseMint: base,
      quoteMint: quote,
      lpMint: pool.lpMint.toBase58(),
      hookProgram: pool.hookProgram?.toBase58() ?? null,
      lpFeeBps: pool.lpFeeBps,
      protocolFeeBps: pool.protocolFeeBps,
      curve: pool.curve,
      native: isNativePool(pool),
      baseReserve: pool.baseReserve.toString(),
      quoteReserve: poolQuoteBooks(pool).toString(),
      virtualBase: pool.virtualBase.toString(),
      virtualQuote: pool.virtualQuote.toString(),
      price,
      priceSol: quoteSol === null ? null : price * quoteSol,
      // A curve's unsold tokens aren't liquidity: count its real SOL only.
      liquiditySol: quoteSol === null ? null : (pool.curve ? quoteSide : quoteSide + baseSide * price) * quoteSol,
      createdAt: pool.createdAt,
      lastSwapAt: pool.lastSwapAt,
      swapCount: Number(pool.swapCount),
      quoteVolume: whole(pool.quoteVolume, dec(quote)),
    };
  });

  const byToken = new Map<string, PoolRow[]>();
  for (const p of pools) {
    for (const m of [p.baseMint, p.quoteMint]) {
      if (m === SOL) continue;
      byToken.set(m, [...(byToken.get(m) ?? []), p]);
    }
  }

  const tokens: TokenRow[] = [];
  for (const [mint, its] of byToken) {
    const m = mints.get(mint);
    if (!m) continue;
    const asBase = its.filter((p) => p.baseMint === mint).sort((a, b) => (b.liquiditySol ?? 0) - (a.liquiditySol ?? 0));
    const best = asBase[0] ?? null;
    const w = wrapped.get(mint);
    const supply = w?.underlyingSupply ?? whole(m.supply, m.decimals);
    const priceSol = best?.priceSol ?? (solPrice.get(mint)?.price ?? null);
    const l = launches.get(mint);
    tokens.push({
      mint,
      name: m.name,
      symbol: m.symbol,
      decimals: m.decimals,
      supply,
      hookProgram: m.hookProgram?.toBase58() ?? null,
      creator: m.creator.toBase58(),
      createdAt: m.createdAt,
      pool: best?.address ?? null,
      pools: its.map((p) => p.address),
      priceSol,
      mcapSol: priceSol === null ? null : priceSol * supply,
      liquiditySol: its.reduce((a, p) => a + (p.liquiditySol ?? 0), 0),
      bridged: w ? { underlying: w.underlying, wrapped: whole(w.totalWrapped, m.decimals) } : null,
      launch: l
        ? {
            status: l.status === 1 ? 'graduated' : 'curve',
            progress: l.status === 1 ? 1 : Math.min(1, Number(BigInt(best?.quoteReserve ?? '0')) / Number(l.graduationQuote || 1n)),
            creatorFeeBps: l.creatorFeeBps,
            graduatedAt: l.graduatedAt,
          }
        : null,
    });
  }
  tokens.sort((a, b) => (b.mcapSol ?? 0) - (a.mcapSol ?? 0));
  return { at: Math.floor(Date.now() / 1000), pools, tokens };
}

/** The whole market from chain. */
export async function readMarket(conn: Connection): Promise<Market> {
  const [raw, launches, wrapped] = await Promise.all([fetchPools(conn), fetchLaunches(conn), fetchWrapped(conn)]);
  const mintSet = new Set<string>();
  for (const { pool } of raw) {
    mintSet.add(pool.baseMint.toBase58());
    mintSet.add(pool.quoteMint.toBase58());
  }
  const mints = await fetchMints(conn, [...mintSet]);
  return buildMarket(raw, mints, launches, wrapped);
}
