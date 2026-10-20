import { createContext, useContext, type ReactNode } from 'react';
import { usePoll, type Overview, type Token } from './api';

// The scanner's token list and overview, polled once for every page.

type MarketState = { tokens: Token[]; solUsd: number | null; overview: Overview | null; at: number | null; error: string | null; retryable: boolean; loading: boolean; retry: () => void };
const Ctx = createContext<MarketState>({ tokens: [], solUsd: null, overview: null, at: null, error: null, retryable: true, loading: false, retry: () => {} });

export function MarketProvider({ children }: { children: ReactNode }) {
  const t = usePoll<{ at: number; solUsd: number | null; tokens: Token[] }>('/api/tokens', 15_000);
  const o = usePoll<Overview>('/api/overview', 15_000);
  return (
    <Ctx.Provider value={{ tokens: t.data?.tokens ?? [], solUsd: t.data?.solUsd ?? null, overview: o.data, at: t.data?.at ?? null, error: t.error, retryable: t.retryable, loading: t.loading, retry: () => (t.refresh(), o.refresh()) }}>
      {children}
    </Ctx.Provider>
  );
}

export const useMarket = () => useContext(Ctx);
export const useToken = (mint: string | undefined) => {
  const { tokens } = useMarket();
  return tokens.find((t) => t.mint === mint) ?? null;
};
