import { ComputeBudgetProgram, type AddressLookupTableAccount, type Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  BRIDGED_SOL_MINT,
  PACKET_DATA_SIZE,
  SWAP_CONFIG,
  bridge,
  buildV0Transaction,
  decodeHolding,
  decodeLaunch,
  decodePool,
  decodeSwapConfig,
  dexHookSigner,
  fetchCustomHookAccounts,
  fetchHookAccountList,
  fetchTokenHook,
  holdingAddress,
  isNativePool,
  launch as launchIx,
  launchAddress,
  launchKeysOf,
  poolHookAccounts,
  router,
  routerTreasuryQuote,
  swap,
  token,
  transactionSize,
  type Pool,
} from '@bordrless/sdk';
import type { PoolRow, TokenRow } from './market.ts';

// Routes between any two tokens on the Bordrless DEX, built here leg by leg with the SDK: a launch's
// curve or pool (its kit, its custom hook and its SOL cut resolved), any other pool (its token hooks
// and its pool hook resolved), one hop through a shared token when no pool joins the two, and
// Bordrless's router on the leg that moves SOL (native or bridged), so an integrator fee can ride on
// the trade.

const SOL = BRIDGED_SOL_MINT.toBase58();
/** The protocol's lookup table on mainnet, as Bordrless's own prepared swaps load it. */
export const PROTOCOL_TABLE = new PublicKey('4vxVcYLdkqT1rMfGHjAu4kMa9XSEhUdQU5ThVfU5grGQ');
const CU_PER_LEG = 380_000;

/**
 * The router's integrator fee. `bridged` says legs on pools quoted in bridged SOL can carry it too: the
 * router pays those in bridged SOL, so the wallet needs a bridged SOL holding (`feeConfig` checks).
 */
export type FeeConfig = { wallet: PublicKey; bps: number; bridged: boolean } | null;

/** The fee for `wallet` at `bps`, with `bridged` set when its bridged SOL holding and the treasury's exist. */
export async function feeConfig(conn: Connection, wallet: PublicKey, bps: number): Promise<NonNullable<FeeConfig>> {
  const treasury = await dexTreasury(conn);
  const [mine, theirs] = await conn.getMultipleAccountsInfo([holdingAddress(BRIDGED_SOL_MINT, wallet), routerTreasuryQuote(treasury, BRIDGED_SOL_MINT)]);
  return { wallet, bps, bridged: !!mine && !!theirs };
}

/** What a route needs to know of each token beyond its pools: decimals, and a launch's fees per side. */
export type TokenFees = Pick<TokenRow, 'mint' | 'decimals' | 'launch'> & { buyFeeBps: number | null; sellFeeBps: number | null; hookBuyBps: number; hookSellBps: number };

export type Leg = {
  pool: string;
  inMint: string;
  outMint: string;
  /** Relative to the pool: buy spends the quote for the base. */
  side: 'buy' | 'sell';
  launch: boolean;
  /** The pool holds native SOL (else its quote is a token, bridged SOL included). */
  native: boolean;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  feeBps: number;
  priceImpactBps: number;
};

export type Route = {
  inMint: string;
  outMint: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  legs: Leg[];
  /** The integrator fee taken on the SOL leg, in lamports (0 without one). */
  routerFee: string;
  priceImpactBps: number;
  estimate: boolean;
};

// ---- Quoting -------------------------------------------------------------------------------------

/**
 * One leg by constant product on the books (virtual reserves included, as the curve prices), with
 * every fee of that side taken: a launch's whole buy or sell fee and its hook's cut, or a pool's LP and
 * protocol fee. A buy pays its fees from the input, a sell from the output.
 */
export function quoteLeg(p: PoolRow, fees: TokenFees | undefined, inMint: string, amountIn: bigint, slippageBps: number, virt: { base: bigint; quote: bigint }): Leg {
  const side: 'buy' | 'sell' = inMint === p.quoteMint ? 'buy' : 'sell';
  const launch = !!fees?.launch && p.baseMint === fees.mint && p.quoteMint === SOL;
  const feeBps = launch
    ? (side === 'buy' ? (fees!.buyFeeBps ?? 0) + fees!.hookBuyBps : (fees!.sellFeeBps ?? 0) + fees!.hookSellBps)
    : p.lpFeeBps + p.protocolFeeBps;
  const base = BigInt(p.baseReserve) + virt.base;
  const quote = BigInt(p.quoteReserve) + virt.quote;
  const [rin, rout] = side === 'buy' ? [quote, base] : [base, quote];
  const net = side === 'buy' ? amountIn - (amountIn * BigInt(feeBps)) / 10_000n : amountIn;
  const gross = rin + net === 0n ? 0n : (net * rout) / (rin + net);
  const out = side === 'buy' ? gross : gross - (gross * BigInt(feeBps)) / 10_000n;
  const spot = Number(rout) / Number(rin || 1n);
  const exec = Number(gross) / Number(net || 1n);
  return {
    pool: p.address,
    inMint,
    outMint: side === 'buy' ? p.baseMint : p.quoteMint,
    side,
    launch,
    native: p.native,
    amountIn: amountIn.toString(),
    amountOut: out.toString(),
    minAmountOut: ((out * BigInt(10_000 - slippageBps)) / 10_000n).toString(),
    feeBps,
    priceImpactBps: Math.max(0, Math.round((1 - exec / (spot || 1)) * 10_000)),
  };
}

/** The pools that join `a` and `b`, either way round. */
const joining = (pools: PoolRow[], a: string, b: string) => pools.filter((p) => (p.baseMint === a && p.quoteMint === b) || (p.baseMint === b && p.quoteMint === a));

/**
 * The best route from `inMint` to `outMint` for `amountIn`: every direct pool, and every path through
 * one token both sides trade against (SOL first, but any). The router's fee comes off the SOL leg
 * (off a buy's input, off a sell's output), native or bridged when the fee can be paid in it.
 */
export function bestRoute(args: {
  pools: PoolRow[];
  fees: Map<string, TokenFees>;
  inMint: string;
  outMint: string;
  amountIn: bigint;
  slippageBps: number;
  fee: FeeConfig;
}): Route | null {
  const { pools, fees, inMint, outMint, amountIn, slippageBps, fee } = args;
  const v = (p: PoolRow) => ({ base: BigInt(p.virtualBase), quote: BigInt(p.virtualQuote) });
  const feeOn = (lamports: bigint) => (fee ? (lamports * BigInt(fee.bps)) / 10_000n : 0n);
  const carries = (p: PoolRow) => !!fee && (p.native || fee.bridged);
  const live = pools.filter((p) => BigInt(p.baseReserve) > 0n && BigInt(p.quoteReserve) > 0n);

  const candidates: Route[] = [];
  const consider = (path: PoolRow[]) => {
    let amount = amountIn;
    let mint = inMint;
    let routerFee = 0n;
    const legs: Leg[] = [];
    for (const p of path) {
      if (mint === SOL && carries(p)) {
        // A buy pays the router's fee from its input before the DEX swaps the rest.
        const f = feeOn(amount);
        routerFee += f;
        amount -= f;
      }
      const leg = quoteLeg(p, fees.get(p.baseMint), mint, amount, slippageBps, v(p));
      legs.push(leg);
      mint = leg.outMint;
      // The next leg spends what this one is sure to deliver.
      amount = BigInt(leg.minAmountOut);
    }
    if (mint !== outMint) return;
    const last = legs[legs.length - 1];
    let out = BigInt(last.amountOut);
    let min = BigInt(last.minAmountOut);
    if (outMint === SOL && carries(path[path.length - 1])) {
      // A sell pays the router's fee from the SOL it delivers.
      const f = feeOn(out);
      routerFee += f;
      out -= f;
      min -= feeOn(min);
    }
    candidates.push({
      inMint,
      outMint,
      amountIn: amountIn.toString(),
      amountOut: out.toString(),
      minAmountOut: min.toString(),
      legs,
      routerFee: routerFee.toString(),
      priceImpactBps: legs.reduce((a, l) => a + l.priceImpactBps, 0),
      estimate: true,
    });
  };

  for (const p of joining(live, inMint, outMint)) consider([p]);
  const via = new Set<string>();
  for (const p of live) {
    if (p.baseMint === inMint) via.add(p.quoteMint);
    if (p.quoteMint === inMint) via.add(p.baseMint);
  }
  for (const m of via) {
    if (m === outMint) continue;
    const first = joining(live, inMint, m);
    const second = joining(live, m, outMint);
    for (const a of first) for (const b of second) consider([a, b]);
  }
  candidates.sort((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : -1));
  return candidates[0] ?? null;
}

// ---- Building ------------------------------------------------------------------------------------

let tableCache: { at: number; table: AddressLookupTableAccount | null } | null = null;
async function protocolTable(conn: Connection) {
  if (!tableCache || Date.now() - tableCache.at > 600_000) tableCache = { at: Date.now(), table: (await conn.getAddressLookupTable(PROTOCOL_TABLE)).value };
  return tableCache.table;
}

let treasuryCache: PublicKey | null = null;
async function dexTreasury(conn: Connection) {
  if (!treasuryCache) treasuryCache = decodeSwapConfig((await conn.getAccountInfo(SWAP_CONFIG))!.data).treasury;
  return treasuryCache;
}

/** A holding the trader needs for `mint`, created first when it doesn't exist yet. */
async function ensureHolding(conn: Connection, trader: PublicKey, mint: PublicKey, out: TransactionInstruction[], made: Set<string>) {
  if (mint.equals(BRIDGED_SOL_MINT) || made.has(mint.toBase58())) return holdingAddress(mint, trader);
  const h = holdingAddress(mint, trader);
  if (!(await conn.getAccountInfo(h))) out.push(token.createHolding(trader, mint, trader));
  made.add(mint.toBase58());
  return h;
}

/** One leg's instructions: its holdings, then the swap (a launch's through its launch keys, any other pool with its hooks resolved). */
async function legInstructions(
  conn: Connection,
  trader: PublicKey,
  leg: Leg,
  made: Set<string>,
): Promise<{ ixs: TransactionInstruction[]; swapIx: TransactionInstruction; post: TransactionInstruction[]; native: boolean }> {
  const poolKey = new PublicKey(leg.pool);
  const pool: Pool = decodePool((await conn.getAccountInfo(poolKey))!.data);
  const native = isNativePool(pool);
  const direction = leg.side === 'buy' ? 1 : 0;
  const amountIn = BigInt(leg.amountIn);
  const minOut = BigInt(leg.minAmountOut);
  const ixs: TransactionInstruction[] = [];
  const traderBase = await ensureHolding(conn, trader, pool.baseMint, ixs, made);

  if (leg.launch) {
    const l = decodeLaunch((await conn.getAccountInfo(launchAddress(pool.baseMint)))!.data);
    const custom = l.customHook ? await fetchCustomHookAccounts(conn, l.customHook, l.mint) : null;
    const keys = launchKeysOf(l, custom, { poolNative: native });
    const swapIx = native ? launchIx.swapV2(keys, trader, trader, direction, amountIn, minOut) : launchIx.swap(keys, trader, trader, direction, amountIn, minOut);
    return { ixs, swapIx, post: [], native };
  }

  // Any other pool: each side's token hook as this transfer resolves it, and the pool hook's extras. A
  // pool quoted in bridged SOL (not native) trades it from a holding: wrap the input first, and unwrap
  // what the swap delivers above what the wallet held.
  const post: TransactionInstruction[] = [];
  let traderQuote = trader;
  if (!native) {
    traderQuote = holdingAddress(pool.quoteMint, trader);
    const held = await conn.getAccountInfo(traderQuote);
    if (!held && !made.has(pool.quoteMint.toBase58())) ixs.push(token.createHolding(trader, pool.quoteMint, trader));
    made.add(pool.quoteMint.toBase58());
    if (pool.quoteMint.equals(BRIDGED_SOL_MINT)) {
      if (leg.side === 'buy') ixs.push(bridge.wrapSol(trader, amountIn));
      else post.push(bridge.unwrapSolAbove(trader, held ? decodeHolding(held.data).amount : 0n));
    }
  }
  const baseOut = leg.side === 'buy';
  const baseHook = await fetchTokenHook(conn, {
    mint: pool.baseMint,
    source: baseOut ? pool.baseVault : traderBase,
    destination: baseOut ? traderBase : pool.baseVault,
    authority: baseOut ? poolKey : trader,
    sourceOwner: baseOut ? poolKey : trader,
    destinationOwner: baseOut ? trader : poolKey,
  });
  const poolExtras = pool.hookProgram
    ? poolHookAccounts(await fetchHookAccountList(conn, pool.hookProgram, poolKey), dexHookSigner(pool.hookProgram), poolKey, pool.baseMint, pool.quoteMint, trader)
    : [];
  if (native) {
    const swapIx = swap.swapV2WithHooks(
      { trader, pool: poolKey, baseMint: pool.baseMint, traderBase, traderQuote: trader, hookProgram: pool.hookProgram },
      { direction, amountIn, minAmountOut: minOut },
      { baseHook, poolExtras },
    );
    return { ixs, swapIx, post, native };
  }
  const quoteHook = await fetchTokenHook(conn, {
    mint: pool.quoteMint,
    source: baseOut ? traderQuote : pool.quoteVault,
    destination: baseOut ? pool.quoteVault : traderQuote,
    authority: baseOut ? trader : poolKey,
    sourceOwner: baseOut ? trader : poolKey,
    destinationOwner: baseOut ? poolKey : trader,
  });
  const swapIx = swap.swapWithHooks(
    { trader, pool: poolKey, baseMint: pool.baseMint, quoteMint: pool.quoteMint, traderBase, traderQuote, hookProgram: pool.hookProgram },
    { direction, amountIn, minAmountOut: minOut },
    { inHook: baseOut ? quoteHook : baseHook, outHook: baseOut ? baseHook : quoteHook, poolExtras },
  );
  return { ixs, swapIx, post, native };
}

export type PreparedRoute = { transactions: { transaction: string; version: 'v0'; stage: number; label: string }[]; route: Route };

/**
 * The route's transactions, unsigned, for the trader's wallet: one when every leg fits in 1,232 bytes,
 * else one per leg (sent in order; a later leg spends what the earlier is sure to deliver). The SOL leg
 * goes through Bordrless's router when `fee` is set (a bridged one when `fee.bridged`); its amount in
 * is then the trader's whole input.
 */
export async function prepareRoute(conn: Connection, trader: PublicKey, route: Route, fee: FeeConfig, priorityMicroLamports = 20_000): Promise<PreparedRoute> {
  const made = new Set<string>();
  const table = await protocolTable(conn);
  const treasury = fee ? await dexTreasury(conn) : null;
  const legIxs: TransactionInstruction[][] = [];
  for (const [i, leg] of route.legs.entries()) {
    const carries = !!fee && (leg.native || fee.bridged);
    const solIn = carries && leg.inMint === SOL;
    const solOut = carries && leg.outMint === SOL && i === route.legs.length - 1;
    // The router takes its fee from the whole input, then the DEX swaps the rest: build the swap (and a
    // bridged pool's wrap) on the whole input; the quote spent the net.
    const whole = solIn ? BigInt(leg.amountIn) + (BigInt(leg.amountIn) * BigInt(fee!.bps)) / BigInt(10_000 - fee!.bps) : BigInt(leg.amountIn);
    const built = await legInstructions(conn, trader, { ...leg, amountIn: whole.toString() }, made);
    let swapIx = built.swapIx;
    if (fee && treasury && (solIn || solOut)) {
      const min = solOut ? BigInt(route.minAmountOut) : undefined;
      // A native pool pays the fee in SOL from the wallet; a bridged pool in bridged SOL from the
      // holdings (a sell's before it unwraps).
      swapIx = built.native
        ? router.swapV2(trader, fee.wallet, treasury, swapIx, fee.bps, min)
        : router.swap(trader, holdingAddress(BRIDGED_SOL_MINT, fee.wallet), routerTreasuryQuote(treasury, BRIDGED_SOL_MINT), swapIx, fee.bps, min);
    }
    legIxs.push([...built.ixs, swapIx, ...built.post]);
  }

  const budget = (legs: number) => [ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, CU_PER_LEG * legs) }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports })];
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tables = table ? [table] : [];
  const one = buildV0Transaction(trader, [...budget(legIxs.length), ...legIxs.flat()], blockhash, tables);
  const sym = (m: string) => (m === SOL ? 'SOL' : `${m.slice(0, 4)}…`);
  if (legIxs.length === 1 || transactionSize(one) <= PACKET_DATA_SIZE) {
    return { route, transactions: [{ transaction: Buffer.from(one.serialize()).toString('base64'), version: 'v0', stage: 0, label: `Swap ${sym(route.inMint)} → ${sym(route.outMint)}` }] };
  }
  return {
    route,
    transactions: legIxs.map((ixs, i) => ({
      transaction: Buffer.from(buildV0Transaction(trader, [...budget(1), ...ixs], blockhash, tables).serialize()).toString('base64'),
      version: 'v0' as const,
      stage: i,
      label: `Leg ${i + 1} of ${legIxs.length}: ${sym(route.legs[i].inMint)} → ${sym(route.legs[i].outMint)}`,
    })),
  };
}
