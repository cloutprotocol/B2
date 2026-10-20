import { useNavigate, useSearchParams } from 'react-router-dom';
import { SwapCard } from '../components/SwapCard';
import { B2_COIN } from '../api';
import { useMarket } from '../market';
import { TokenIcon } from '../components/TokenIcon';
import { pct, sol } from '../format';

export function SwapPage() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
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
            {/* a row opens the token's page; Swap loads it into the card above (and scrolls up to it) */}
            {movers.map((t) => (
              <div key={t.mint} role="link" tabIndex={0} className="mover" onClick={() => nav(`/token/${t.mint}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/token/${t.mint}`)}>
                <TokenIcon src={t.image} symbol={t.symbol} size={24} />
                <b style={{ flex: 1 }}>{t.symbol}</b>
                <span className="mono num muted" style={{ fontSize: 12 }}>
                  {sol(t.mcapSol, 1)}
                </span>
                <span className={`mono num ${(t.priceChange24h ?? 0) >= 0 ? 'up' : 'down'}`} style={{ fontSize: 12, width: 58, textAlign: 'right' }}>
                  {pct(t.priceChange24h)}
                </span>
                <button
                  type="button"
                  className="mover-swap"
                  aria-label={`Swap ${t.symbol}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setParams({ token: t.mint });
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                >
                  Swap
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
