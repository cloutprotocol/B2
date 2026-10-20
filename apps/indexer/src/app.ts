import { Connection, PublicKey } from '@solana/web3.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodeHolding, holdingAddress } from '@bordrless/sdk';
import {
  B2_HOOK,
  BRIDGED_SOL_MINT,
  bestRoute,
  feeConfig,
  prepareRoute,
  type FeeConfig,
  type TokenFees,
  bordrless,
  fetchSteps,
  readLaunchMachine,
  readMachine,
  readMarket,
  type ApiLaunch,
  type LaunchMachine,
  type Machine,
  type Market,
  type Step,
} from '@b2/core';

// The indexer: reads the whole Bordrless market from chain, enriches it from Bordrless's API, serves it
// to the web app, prepares swaps, and proxies the browser's RPC calls so the RPC key stays server-side.
// Two hosts run it: main.ts (a long-running server, refreshed by timers) and vercel.ts (a serverless
// function, refreshed on demand by fresh()). Read B2_RPC from the environment before importing this.

const RPC = process.env.B2_RPC;
/** Set when the server can't read the chain: every request answers with it. */
export const configError = RPC ? null : 'B2_RPC is not set: give it a mainnet RPC URL that serves getProgramAccounts.';
const conn = new Connection(RPC ?? 'https://api.mainnet-beta.solana.com', 'confirmed');

/**
 * The router's integrator fee: off unless a wallet is set (it must hold at least rent: about 0.001 SOL).
 * Pools quoted in bridged SOL carry it once the wallet has a bridged SOL holding; checked each enrichment.
 */
const FEE_WALLET = process.env.B2_FEE_WALLET ? new PublicKey(process.env.B2_FEE_WALLET) : null;
const FEE_BPS = Math.min(100, Math.max(1, Number(process.env.B2_FEE_BPS ?? 50)));
let FEE: FeeConfig = FEE_WALLET ? { wallet: FEE_WALLET, bps: FEE_BPS, bridged: false } : null;
const SOL = BRIDGED_SOL_MINT.toBase58();

const MARKET_SECS = 15;
const ENRICH_SECS = 60;

// ---- State ---------------------------------------------------------------------------------------

let market: Market | null = null;
let launches = new Map<string, ApiLaunch>();
let poolExtras = new Map<string, { volume24hUsd: number; image: string | null }>();
let solUsd: number | null = null;
/** Each pool's cumulative quote volume over time, for our own 24 h volume once we have a day of it. */
const volumeHistory = new Map<string, { at: number; v: number }[]>();

export async function refreshMarket() {
  try {
    market = await readMarket(conn);
    for (const p of market.pools) {
      const h = volumeHistory.get(p.address) ?? [];
      h.push({ at: market.at, v: p.quoteVolume });
      while (h.length && h[0].at < market.at - 86_400 - 600) h.shift();
      volumeHistory.set(p.address, h);
    }
  } catch (e) {
    console.error('market:', (e as Error).message);
  }
}

export async function refreshEnrichment() {
  try {
    const [o, ls, ps] = await Promise.all([bordrless.overview(), bordrless.launches(), bordrless.pools()]);
    solUsd = o.solUsd;
    launches = new Map(ls.map((l) => [l.mint, l]));
    poolExtras = new Map(ps.pools.map((p) => [p.pool, { volume24hUsd: p.volume24hUsd, image: p.baseImage }]));
    if (FEE_WALLET) FEE = await feeConfig(conn, FEE_WALLET, FEE_BPS);
  } catch (e) {
    console.error('enrich:', (e as Error).message);
  }
}

/** Bordrless's companion tag in a word: the game it runs, a Workshop script, Snowball, or a plain buyback. */
function companionLabel(c: unknown): string | null {
  if (!c || typeof c !== 'object') return null;
  const t = c as { game?: unknown; script?: boolean; snowball?: boolean };
  if (t.game) return typeof t.game === 'string' ? t.game : 'game';
  if (t.snowball) return 'snowball';
  if (t.script) return 'script';
  return 'buyback';
}

/** Our own 24 h quote volume for a pool, once we've watched it a day; null before. */
function ownVolume24h(pool: string): number | null {
  const h = volumeHistory.get(pool);
  if (!h || h.length < 2 || h[h.length - 1].at - h[0].at < 86_400) return null;
  return h[h.length - 1].v - h[0].v;
}

function tokens() {
  if (!market) return [];
  return market.tokens.map((t) => {
    const l = launches.get(t.mint);
    return {
      ...t,
      image: l?.image ?? poolExtras.get(t.pool ?? '')?.image ?? null,
      holders: l?.holders ?? null,
      volume24hUsd: l?.volume24hUsd ?? (t.pool ? poolExtras.get(t.pool)?.volume24hUsd ?? null : null),
      priceChange24h: l?.priceChange24h ?? null,
      trades24h: l?.trades24h ?? null,
      buyFeeBps: l?.buyFeeBps ?? null,
      sellFeeBps: l?.sellFeeBps ?? null,
      companionTag: companionLabel(l?.companionTag),
      spark: l?.spark ?? null,
      b2: t.hookProgram === B2_HOOK.toBase58(),
      socials: l ? { website: l.website, twitter: l.twitter, telegram: l.telegram } : null,
    };
  });
}

/** Each token's fees per side for routing: a launch's whole fee from Bordrless, its hook's cut from the Workshop reading. */
function routeFees(): Map<string, TokenFees> {
  const out = new Map<string, TokenFees>();
  for (const t of market?.tokens ?? []) {
    const l = launches.get(t.mint);
    const rules = l?.customHook?.workshop?.reading?.rules ?? [];
    const hook = (on: string) => rules.filter((r) => r.on === on && r.to !== 'none').reduce((a, r) => Math.max(a, r.bps), 0);
    out.set(t.mint, { mint: t.mint, decimals: t.decimals, launch: t.launch, buyFeeBps: l?.buyFeeBps ?? null, sellFeeBps: l?.sellFeeBps ?? null, hookBuyBps: hook('buy'), hookSellBps: hook('sell') });
  }
  return out;
}

// ---- On demand (serverless) -----------------------------------------------------------------------

let marketAt = 0;
let enrichAt = 0;
let marketJob: Promise<void> | null = null;
let enrichJob: Promise<void> | null = null;

/**
 * Freshen the state for a request when no timer runs (a serverless function): a refresh that is due
 * starts once, however many requests arrive; the request waits for it only while there's no data yet
 * or the data is over two minutes old, and otherwise is served what's cached while it runs.
 */
export async function fresh() {
  const now = Date.now();
  if (now - marketAt > MARKET_SECS * 1000) marketJob ??= refreshMarket().finally(() => ((marketAt = Date.now()), (marketJob = null)));
  if (now - enrichAt > ENRICH_SECS * 1000) enrichJob ??= refreshEnrichment().finally(() => ((enrichAt = Date.now()), (enrichJob = null)));
  const stale = !market || now - marketAt > 120_000 || !launches.size;
  if (stale) await Promise.all([marketJob, enrichJob]);
}

// ---- Machine view caches -------------------------------------------------------------------------

const machines = new Map<string, { at: number; m: LaunchMachine | null }>();
const b2Machines = new Map<string, { at: number; m: Machine | null }>();
const stepCache = new Map<string, { at: number; m: Step[] }>();

/** A read cached for `ms`; when a fresh read fails, the last good one is served instead (and failing with none). */
async function cached<T>(map: Map<string, { at: number; m: T }>, key: string, ms: number, read: () => Promise<T>): Promise<T> {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.m;
  try {
    const m = await read();
    map.set(key, { at: Date.now(), m });
    return m;
  } catch (e) {
    if (hit) return hit.m;
    throw e;
  }
}

/** Any token's machine: the launch's chain state and its rules in words; B² coins add the B² reading and its steps. */
async function machineOf(mint: string) {
  const key = new PublicKey(mint);
  const token = tokens().find((t) => t.mint === mint) ?? null;
  const api = launches.get(mint) ?? null;
  const launch = token?.launch ? await cached(machines, mint, 4_000, () => readLaunchMachine(conn, key)) : null;
  let b2: { machine: Machine | null; steps: Step[] } | null = null;
  if (token?.b2) {
    const [machine, steps] = await Promise.all([
      cached(b2Machines, mint, 4_000, () => readMachine(conn, key)),
      cached(stepCache, mint, 15_000, () => fetchSteps(RPC!, key, 30)).catch((): Step[] => []),
    ]);
    b2 = { machine, steps };
  }
  return {
    token,
    launch,
    rules: api
      ? {
          rules: api.rules,
          customHook: api.customHook,
          buyFeeBps: api.buyFeeBps,
          sellFeeBps: api.sellFeeBps,
          creatorFeeBps: api.creatorFeeBps,
          lpFeeBps: api.lpFeeBps,
          rewardsDistributedSol: api.rewardsDistributed ? Number(api.rewardsDistributed) / 1e9 : 0,
          burnedTokens: api.burned ? Number(api.burned) / 1e6 : 0,
          creatorShare: api.creatorShare,
          companionTag: api.companionTag,
        }
      : null,
    b2,
  };
}

// ---- HTTP ----------------------------------------------------------------------------------------

/** The RPC methods the browser may call through us: what a wallet swap needs, nothing that scans. */
const RPC_METHODS = new Set([
  'getLatestBlockhash',
  'getBalance',
  'getAccountInfo',
  'getMultipleAccounts',
  'getSignatureStatuses',
  'sendTransaction',
  'simulateTransaction',
  'getTransaction',
  'getFeeForMessage',
  'getMinimumBalanceForRentExemption',
  'getSlot',
  'getBlockHeight',
  'getEpochInfo',
  'getGenesisHash',
  'getVersion',
]);

/**
 * A JSON answer. `edge` lets Vercel's CDN serve it for that many seconds (and stale for 30 more while it
 * refreshes), so most visits never reach the function or the RPC; everything else is never cached.
 */
const json = (res: ServerResponse, status: number, body: unknown, edge = 0) => {
  const cache = edge && status === 200 ? `public, max-age=0, s-maxage=${edge}, stale-while-revalidate=30` : 'no-store';
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': cache, ...(status === 503 ? { 'retry-after': '3' } : {}) });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

const readBody = (req: IncomingMessage) =>
  new Promise<any>((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 200_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

const isKey = (s: unknown): s is string => {
  try {
    return typeof s === 'string' && new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
};

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://local');
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' });
    return res.end();
  }

  if (url.pathname === '/rpc' && req.method === 'POST') {
    const body = await readBody(req);
    const calls = Array.isArray(body) ? body : [body];
    if (!calls.every((c) => RPC_METHODS.has(c?.method))) return json(res, 403, { error: 'method not allowed through this proxy' });
    const upstream = await fetch(RPC!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    res.writeHead(upstream.status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(await upstream.text());
  }

  if (parts[0] !== 'api') return json(res, 404, { error: 'not found' });
  // every answer below reads the market: until the first scan lands (a cold start, a busy RPC), say so
  if (!market && parts[1] !== 'balance') return json(res, 503, { error: 'Loading the market from Solana. One moment.', retry: true });

  switch (parts[1]) {
    case 'overview': {
      const ts = tokens();
      return json(res, 200, {
        at: market?.at ?? null,
        solUsd,
        tokens: ts.length,
        pools: market?.pools.length ?? 0,
        liquiditySol: market?.pools.reduce((a, p) => a + (p.liquiditySol ?? 0), 0) ?? 0,
        volume24hUsd: [...poolExtras.values()].reduce((a, p) => a + (p.volume24hUsd ?? 0), 0),
        graduated: ts.filter((t) => t.launch?.status === 'graduated').length,
        onCurve: ts.filter((t) => t.launch?.status === 'curve').length,
      }, 5);
    }
    case 'tokens':
      return json(res, 200, { at: market?.at ?? null, solUsd, tokens: tokens() }, 5);
    case 'pools':
      return json(res, 200, {
        at: market?.at ?? null,
        solUsd,
        pools: (market?.pools ?? []).map((p) => ({ ...p, volume24hUsd: poolExtras.get(p.address)?.volume24hUsd ?? null, ownVolume24hQuote: ownVolume24h(p.address) })),
      }, 5);
    case 'token': {
      const mint = parts[2];
      if (!isKey(mint)) return json(res, 400, { error: "That isn't a token address." });
      const t = tokens().find((x) => x.mint === mint);
      if (!t) return json(res, 404, { error: "This token isn't on the Bordrless DEX." });
      const [candles, trades] = await Promise.all([
        t.launch ? bordrless.candles(mint).catch(() => ({ candles: [] })) : { candles: [] },
        t.launch ? bordrless.trades(mint).catch(() => ({ trades: [] })) : { trades: [] },
      ]);
      return json(res, 200, { solUsd, token: t, pools: market!.pools.filter((p) => t.pools.includes(p.address)), ...candles, ...trades }, 5);
    }
    case 'machine': {
      const mint = parts[2];
      if (!isKey(mint)) return json(res, 400, { error: "That isn't a token address." });
      const m = await machineOf(mint);
      if (!m.token) return json(res, 404, { error: "This token isn't on the Bordrless DEX." });
      const trades = m.token.launch ? await bordrless.trades(mint).catch(() => ({ trades: [] })) : { trades: [] };
      return json(res, 200, { solUsd, ...m, ...trades }, 3);
    }
    case 'balance': {
      // A wallet's SOL and its holdings of the mints asked for, in base units.
      const owner = parts[2];
      const mints = (url.searchParams.get('mints') ?? '').split(',').filter((m) => isKey(m) && m !== SOL).slice(0, 20);
      if (!isKey(owner)) return json(res, 400, { error: 'bad owner' });
      const ownerKey = new PublicKey(owner);
      const [lamports, infos] = await Promise.all([
        conn.getBalance(ownerKey),
        conn.getMultipleAccountsInfo(mints.map((m) => holdingAddress(new PublicKey(m), ownerKey))),
      ]);
      const tokens: Record<string, string> = {};
      mints.forEach((m, i) => (tokens[m] = infos[i] ? decodeHolding(infos[i]!.data).amount.toString() : '0'));
      return json(res, 200, { sol: String(lamports), tokens });
    }
    case 'route': {
      // Any token to any token: the best direct pool or one hop, built here, the router's fee on the SOL leg.
      if (req.method !== 'POST') return json(res, 405, { error: 'POST' });
      const b = await readBody(req);
      const slippageBps = Math.min(5_000, Math.max(1, Number(b.slippageBps ?? 100)));
      if (!isKey(b.inMint) || !isKey(b.outMint) || b.inMint === b.outMint || !/^\d+$/.test(String(b.amount))) {
        return json(res, 400, { error: 'inMint, outMint and amount (base units) required' });
      }
      const route = bestRoute({ pools: market?.pools ?? [], fees: routeFees(), inMint: b.inMint, outMint: b.outMint, amountIn: BigInt(b.amount), slippageBps, fee: FEE });
      if (!route) return json(res, 404, { error: 'No route between these tokens on the Bordrless DEX.' });
      if (parts[2] !== 'prepare') return json(res, 200, { ...route, feeBps: FEE?.bps ?? 0 });
      if (!isKey(b.owner)) return json(res, 400, { error: 'owner required' });
      try {
        const prep = await prepareRoute(conn, new PublicKey(b.owner), route, FEE);
        return json(res, 200, { builder: 'b2', ...prep, feeBps: FEE?.bps ?? 0 });
      } catch (e) {
        // A single launch leg can still go through Bordrless's own prepare.
        const leg = route.legs.length === 1 ? route.legs[0] : null;
        if (leg?.launch) {
          const mint = leg.side === 'buy' ? leg.outMint : leg.inMint;
          const r = await bordrless.prepare({ mint, side: leg.side, amount: leg.amountIn, slippageBps, owner: b.owner, solMode: 'SOL' });
          return json(res, r.status, { builder: 'bordrless', ...(r.body as object), fallback: (e as Error).message });
        }
        throw e;
      }
    }
    default:
      return json(res, 404, { error: 'not found' });
  }
}

/** Answer one request (`/api/...` or `/rpc`); errors become a JSON 500. */
export function handle(req: IncomingMessage, res: ServerResponse) {
  if (configError) return json(res, 500, { error: configError });
  return route(req, res).catch((e) => {
    console.error(req.url, e);
    if (res.headersSent) return;
    const m = String((e as Error)?.message ?? e);
    // a busy or unreachable node: worth trying again in a moment
    if (/429|too many|rate limit|unexpected end of json|not valid json|fetch failed|timed? ?out|econnreset|socket hang up|rpc (5\d\d|unreachable)/i.test(m)) {
      return json(res, 503, { error: 'The Solana RPC is busy right now. Trying again in a moment.', retry: true });
    }
    json(res, 500, { error: 'Something went wrong reading the chain. Try again in a moment.', retry: true, detail: m.slice(0, 200) });
  });
}
