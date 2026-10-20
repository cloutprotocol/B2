import { useEffect, useRef, useState } from 'react';

// The indexer's API (apps/indexer) as the web app reads it.

export const SOL_MINT = 'A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i';
export const B2_COIN = '4iWwcHf9tH6J6UjRgG9rXosXVxNdcKUFuqh1rbps6H7J';

export type Token = {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: number;
  hookProgram: string | null;
  creator: string;
  createdAt: number;
  pool: string | null;
  pools: string[];
  priceSol: number | null;
  mcapSol: number | null;
  liquiditySol: number;
  bridged: { underlying: string; wrapped: number } | null;
  launch: { status: 'curve' | 'graduated'; progress: number; creatorFeeBps: number; graduatedAt: number } | null;
  image: string | null;
  holders: number | null;
  volume24hUsd: number | null;
  priceChange24h: number | null;
  trades24h: number | null;
  buyFeeBps: number | null;
  sellFeeBps: number | null;
  companionTag: string | null;
  spark: number[] | null;
  b2: boolean;
  socials: { website: string | null; twitter: string | null; telegram: string | null } | null;
};

export type Pool = {
  address: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  hookProgram: string | null;
  lpFeeBps: number;
  protocolFeeBps: number;
  curve: boolean;
  native: boolean;
  baseReserve: string;
  quoteReserve: string;
  price: number;
  priceSol: number | null;
  liquiditySol: number | null;
  createdAt: number;
  lastSwapAt: number;
  swapCount: number;
  quoteVolume: number;
  volume24hUsd: number | null;
};

export type Overview = {
  at: number | null;
  solUsd: number | null;
  tokens: number;
  pools: number;
  liquiditySol: number;
  volume24hUsd: number;
  graduated: number;
  onCurve: number;
};

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Trade = { signature: string; ts: number; trader: string; recipient?: string; side: 'buy' | 'sell'; baseAmount: string; quoteAmount: string; priceQuote: number };

export type Machine = {
  mint: string;
  at: number;
  launch: { status: 'curve' | 'graduated'; realQuoteSol: number; graduationSol: number; progress: number; creatorFeeBps: number };
  pool: { address: string; priceSol: number };
  hook: { referenceSol: number; dipLineSol: number; dip: boolean; dips: number; trades: number; movedAt: number } | null;
  script: {
    referenceSol: number;
    guardSol: number;
    lastStepAt: number;
    steps: number;
    lastAction: string;
    pregradSpentSol: number;
    solLegSol: number;
    pairLegSol: number;
    solToDipSol: number;
    lpLocked: { solPool: number; pair: number };
    graduatedSeen: boolean;
  } | null;
  companion: { address: string; potSol: number; heldCoin: number; heldWbordr: number; floorSol: number };
};
export type HookRule = { on: string; to: string; bps: number; text: string; when: string };
export type Rules = {
  rules: {
    holderFeeBuyBps: number;
    holderFeeSellBps: number;
    burnBuyBps: number;
    burnSellBps: number;
    maxWalletBps: number;
    creatorUnlockAt: number | null;
    earlyUnlockAt: number | null;
    walletsOnly: boolean;
  } | null;
  customHook: {
    program: string;
    upgradeable: boolean;
    upgradeAuthority: string | null;
    workshop?: { name: string; author: string; kind: string; reading?: { does: string; rules: HookRule[] } };
  } | null;
  buyFeeBps: number;
  sellFeeBps: number;
  creatorFeeBps: number;
  lpFeeBps: number;
  rewardsDistributedSol: number;
  burnedTokens: number;
  creatorShare: number | null;
};
export type LaunchMachine = {
  mint: string;
  at: number;
  launch: { status: 'curve' | 'graduated'; realQuoteSol: number; graduationSol: number; progress: number; creatorFeeBps: number; lpFeeBps: number; creator: string };
  pool: { address: string; priceSol: number; curve: boolean };
  companion: {
    address: string;
    sol: number;
    split: { buybackBps: number; holdersBps: number; beneficiaryBps: number; potBps: number };
    game: string | null;
    pendingBuybackSol: number;
    pendingHoldersSol: number;
    pendingPotSol: number;
    claimedSol: number;
    spentSol: number;
    burnedTokens: number;
    sharedSol: number;
    paidBeneficiarySol: number;
    bountiesSol: number;
  } | null;
};
export type MachineData = {
  solUsd: number | null;
  token: Token;
  launch: LaunchMachine | null;
  rules: Rules | null;
  b2: { machine: Machine | null; steps: Step[] } | null;
  trades: Trade[];
};

export type Step = { signature: string; slot: number; at: number; action: string; sol: number; amount: number; pot: number };

/** An API failure in words, and whether trying again could help (a busy RPC, a cold server, the network). */
export class ApiError extends Error {
  constructor(message: string, public status: number, public retry: boolean, public body: unknown = null) {
    super(message);
  }
}

/** The body as JSON, `null` when empty, `undefined` when it isn't JSON (a platform error page, a proxy). */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function failure(status: number, body: unknown): ApiError {
  const b = body && typeof body === 'object' ? (body as { error?: unknown; retry?: unknown }) : null;
  if (typeof b?.error === 'string') return new ApiError(b.error, status, b.retry === true || status === 429 || status >= 500, body);
  if (status === 429) return new ApiError('Too many requests right now. Trying again in a moment.', status, true, body);
  if (status >= 500 || status === 0) return new ApiError('The B² server hit a snag reading the chain. Trying again in a moment.', status, true, body);
  return new ApiError(`The server answered unexpectedly (${status}).`, status, false, body);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("Can't reach the B² server. Check your connection.", 0, true);
  }
  const body = await readBody(res);
  if (!res.ok || body === undefined) throw failure(res.ok ? 502 : res.status, body ?? null);
  return body as T;
}

export const getJson = <T,>(path: string) => call<T>(path);
export const postJson = <T,>(path: string, data: unknown) =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

/**
 * Fetches `path` now and every `ms`, keeping the last good answer through errors. With no answer yet, a
 * failure is tried again sooner (2 s, 4 s, 8 s, then every `ms`). `loading` is true while a fetch runs.
 */
export function usePoll<T>(path: string | null, ms: number): { data: T | null; error: string | null; retryable: boolean; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const live = useRef(path);
  const has = useRef(false);
  useEffect(() => {
    if (live.current !== path) {
      setData(null);
      has.current = false;
    }
    live.current = path;
    if (!path) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fails = 0;
    const tick = async () => {
      setLoading(true);
      try {
        const d = await getJson<T>(path);
        if (stop || live.current !== path) return;
        setData(d);
        setError(null);
        has.current = true;
        fails = 0;
      } catch (e) {
        if (stop) return;
        setError(e instanceof ApiError ? e : new ApiError((e as Error).message, 0, true));
        fails++;
      } finally {
        if (!stop) {
          setLoading(false);
          timer = setTimeout(tick, !has.current && fails ? Math.min(ms, 2000 * 2 ** (fails - 1)) : ms);
        }
      }
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [path, ms, nonce]);
  return { data, error: error?.message ?? null, retryable: error?.retry ?? true, loading, refresh: () => setNonce((n) => n + 1) };
}
