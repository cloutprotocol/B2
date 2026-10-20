// Bordrless's public site API (bordrless.app/api, no key): what only their indexer has. The scanner
// uses it to enrich its own chain read (images, holders, 24 h volume and change, the rules in words)
// and the swap uses its quote and prepare for launch coins, whose hooks it resolves exactly.

const BASE = 'https://bordrless.app/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'user-agent': 'b2-indexer', accept: 'application/json' } });
  if (!res.ok) throw new Error(`bordrless ${path}: ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'user-agent': 'b2-indexer', accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

export type ApiLaunch = {
  mint: string;
  name: string;
  symbol: string;
  image: string | null;
  description: string | null;
  status: 'curve' | 'graduated';
  priceUsd: number | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  trades24h: number | null;
  priceChange24h: number | null;
  holders: number | null;
  progress: number;
  buyFeeBps: number;
  sellFeeBps: number;
  companionTag: unknown;
  customHook: ApiCustomHook | null;
  rules: ApiRules | null;
  rewardsDistributed: string | null;
  burned: string | null;
  creatorShare: number | null;
  creatorFeeBps: number;
  lpFeeBps: number;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  spark: number[] | null;
};

export type ApiRules = {
  holderFeeBuyBps: number;
  holderFeeSellBps: number;
  burnBuyBps: number;
  burnSellBps: number;
  maxWalletBps: number;
  creatorUnlockAt: number | null;
  earlyWindowEndsAt: number | null;
  earlyUnlockAt: number | null;
  walletsOnly: boolean;
};

/** A hook rule as the Workshop's reading states it: on what, how much, to where, in words. */
export type HookRule = { on: string; to: string; bps: number; text: string; when: string };
export type ApiCustomHook = {
  program: string;
  flags: number;
  upgradeAuthority: string | null;
  upgradeable: boolean;
  workshop?: { name: string; author: string; kind: string; reading?: { does: string; rules: HookRule[] } };
};

export type ApiOverview = { solUsd: number; launches: number; graduated: number; volume24hUsd: number };

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type ApiTrade = {
  signature: string;
  ts: number;
  trader: string;
  side: 'buy' | 'sell';
  baseAmount: string;
  quoteAmount: string;
  priceQuote: number;
  priceUsd: number | null;
};

export const bordrless = {
  overview: () => get<ApiOverview>('/overview'),
  /** Every launch (the API pages by 100). */
  async launches(): Promise<ApiLaunch[]> {
    const first = await get<{ launches: ApiLaunch[]; total: number }>('/launches?sort=mcap&limit=100&offset=0');
    const out = [...first.launches];
    for (let offset = 100; offset < first.total; offset += 100) {
      out.push(...(await get<{ launches: ApiLaunch[] }>(`/launches?sort=mcap&limit=100&offset=${offset}`)).launches);
    }
    return out;
  },
  pools: () => get<{ pools: { pool: string; volume24hUsd: number; tvlUsd: number; baseImage: string | null }[] }>('/pools'),
  candles: (mint: string) => get<{ candles: Candle[] }>(`/launches/${mint}/candles?unit=quote`),
  trades: (mint: string) => get<{ trades: ApiTrade[] }>(`/launches/${mint}/trades`),
  quote: (req: { mint: string; side: 'buy' | 'sell'; amount: string; slippageBps: number }) => post<unknown>('/swap/quote', req),
  prepare: (req: { mint: string; side: 'buy' | 'sell'; amount: string; slippageBps: number; owner: string; solMode: 'SOL' }) =>
    post<unknown>('/swap/prepare', req),
};
