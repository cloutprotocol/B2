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

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `${res.status}`);
  return body as T;
}

export async function postJson<T>(path: string, data: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body?.error ?? `${res.status}`), { body });
  return body as T;
}

/** Fetches `path` now and every `ms`, keeping the last good answer through errors. */
export function usePoll<T>(path: string | null, ms: number): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const live = useRef(path);
  useEffect(() => {
    if (live.current !== path) setData(null);
    live.current = path;
    if (!path) return;
    let stop = false;
    const tick = async () => {
      try {
        const d = await getJson<T>(path);
        if (!stop && live.current === path) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, ms);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [path, ms, nonce]);
  return { data, error, refresh: () => setNonce((n) => n + 1) };
}
