import { useSearchParams, Link } from 'react-router-dom';
import { SwapCard } from '../components/SwapCard';
import { B2_COIN } from '../api';
import { useMarket } from '../market';
import { TokenIcon } from '../components/TokenIcon';
import { pct, sol } from '../format';

export function SwapPage() {
  const [params] = useSearchParams();
  const { tokens } = useMarket();
  const movers = tokens
    .filter((t) => t.volume24hUsd && t.pool)
    .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0))
    .slice(0, 6);
  return (
    <div className="swap-page">
      <SwapCard initialMint={params.get('token') ?? B2_COIN} />
      {movers.length ? (
        <div>
          <div className="label" style={{ marginBottom: 8 }}>
            Most traded today
          </div>
          <div className="kv">
            {movers.map((t) => (
              <Link key={t.mint} to={`/?token=${t.mint}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid var(--faint)' }}>
                <TokenIcon src={t.image} symbol={t.symbol} size={24} />
                <b style={{ flex: 1 }}>{t.symbol}</b>
                <span className="mono num muted" style={{ fontSize: 12 }}>
                  {sol(t.mcapSol, 1)}
                </span>
                <span className={`mono num ${(t.priceChange24h ?? 0) >= 0 ? 'up' : 'down'}`} style={{ fontSize: 12, width: 64, textAlign: 'right' }}>
                  {pct(t.priceChange24h)}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
