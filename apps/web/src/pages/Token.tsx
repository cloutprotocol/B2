import { Link, useParams } from 'react-router-dom';
import { usePoll, type Candle, type Pool, type Token, type Trade } from '../api';
import { age, compact, pct, price, short, sol, usd } from '../format';
import { Chart } from '../components/Chart';
import { SwapCard } from '../components/SwapCard';
import { TokenIcon } from '../components/TokenIcon';

// One token: its chart and trades, its pools, what it is, and the swap card beside it.

type TokenData = { solUsd: number | null; token: Token; pools: Pool[]; candles: Candle[]; trades: Trade[] };

export function TokenPage() {
  const { mint } = useParams();
  const { data, error } = usePoll<TokenData>(mint ? `/api/token/${mint}` : null, 15_000);
  if (error && !data) return <div className="note err">{error}</div>;
  if (!data) return <div className="note">Loading…</div>;
  const { token: t, solUsd, pools, candles, trades } = data;
  const usdOf = (s: number | null) => (s !== null && solUsd ? s * solUsd : null);

  return (
    <div>
      <div className="token-head">
        <TokenIcon src={t.image} symbol={t.symbol} size={56} />
        <div>
          <h1>
            {t.name} <span className="muted" style={{ fontWeight: 500 }}>{t.symbol}</span>
          </h1>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <span className="chip mono" title={t.mint} onClick={() => navigator.clipboard?.writeText(t.mint)} style={{ cursor: 'copy' }}>
              {short(t.mint)} ⧉
            </span>
            {t.b2 ? <span className="chip dark">B²</span> : null}
            {t.companionTag ? <span className="chip">{t.companionTag}</span> : null}
            {t.launch ? <span className="chip">{t.launch.status === 'curve' ? `curve ${Math.round(t.launch.progress * 100)}%` : 'graduated'}</span> : null}
            {t.bridged ? <span className="chip">bridged from {short(t.bridged.underlying)}</span> : null}
            {t.socials?.twitter ? (
              <a className="chip" href={t.socials.twitter} target="_blank" rel="noreferrer">
                X
              </a>
            ) : null}
            {t.socials?.telegram ? (
              <a className="chip" href={t.socials.telegram} target="_blank" rel="noreferrer">
                Telegram
              </a>
            ) : null}
            <a className="chip" href={`https://bordrless.app/token/${t.mint}`} target="_blank" rel="noreferrer">
              bordrless.app ↗
            </a>
            <a className="chip" href={`https://solscan.io/account/${t.mint}`} target="_blank" rel="noreferrer">
              Solscan ↗
            </a>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <Link to={`/machine/${t.mint}`} className="btn primary">
          Machine view →
        </Link>
      </div>

      <div className="stats" style={{ marginBottom: 22 }}>
        <div className="stat">
          <span className="label">Price</span>
          <span className="v mono">{price(t.priceSol)}</span>
          <span className="muted mono" style={{ fontSize: 12 }}>
            {usdOf(t.priceSol) ? `$${price(usdOf(t.priceSol))}` : ''}
          </span>
        </div>
        <div className="stat">
          <span className="label">24h</span>
          <span className={`v ${(t.priceChange24h ?? 0) >= 0 ? 'up' : 'down'}`}>{pct(t.priceChange24h)}</span>
        </div>
        <div className="stat">
          <span className="label">Market cap</span>
          <span className="v">{sol(t.mcapSol, 1)}</span>
          <span className="muted mono" style={{ fontSize: 12 }}>
            {usd(usdOf(t.mcapSol))}
          </span>
        </div>
        <div className="stat">
          <span className="label">Liquidity</span>
          <span className="v">{sol(t.liquiditySol, 1)}</span>
        </div>
        <div className="stat">
          <span className="label">Volume 24h</span>
          <span className="v">{usd(t.volume24hUsd)}</span>
        </div>
        <div className="stat">
          <span className="label">Holders</span>
          <span className="v">{t.holders ?? '—'}</span>
        </div>
      </div>

      <div className="token-grid">
        <div>
          <div className="chart-box">
            {candles.length ? <Chart candles={candles} /> : <div className="chart-empty note">No candles for this pool yet.</div>}
          </div>

          <div className="label section-title">Latest trades</div>
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th className="l">Side</th>
                  <th>SOL</th>
                  <th>{t.symbol}</th>
                  <th>Price</th>
                  <th className="l">Trader</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {trades.slice(0, 30).map((x) => (
                  <tr key={x.signature} className="row" onClick={() => window.open(`https://solscan.io/tx/${x.signature}`, '_blank')}>
                    <td className={`l mono ${x.side === 'buy' ? 'up' : 'down'}`}>{x.side}</td>
                    <td className="mono">{compact(Number(x.quoteAmount) / 1e9, 3)}</td>
                    <td className="mono">{compact(Number(x.baseAmount) / 10 ** t.decimals)}</td>
                    <td className="mono">{price(x.priceQuote)}</td>
                    <td className="l mono muted">{short(x.trader)}</td>
                    <td className="mono muted">{age(x.ts)}</td>
                  </tr>
                ))}
                {trades.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="l muted">
                      No trades from the indexer for this token.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="side">
          <SwapCard initialMint={t.mint} compactCard />
          <div className="kv">
            <div>
              <span>Supply</span>
              <span className="mono">{compact(t.supply)}</span>
            </div>
            <div>
              <span>Buy · sell fee</span>
              <span className="mono">
                {t.buyFeeBps !== null ? `${(t.buyFeeBps / 100).toFixed(2)}% · ${((t.sellFeeBps ?? 0) / 100).toFixed(2)}%` : '—'}
              </span>
            </div>
            <div>
              <span>Token hook</span>
              <span className="mono">{t.hookProgram ? short(t.hookProgram) : 'none'}</span>
            </div>
            <div>
              <span>Creator</span>
              <span className="mono">{short(t.creator)}</span>
            </div>
            <div>
              <span>Created</span>
              <span className="mono">{age(t.createdAt)} ago</span>
            </div>
          </div>
          <div className="label">Pools</div>
          <div className="kv">
            {pools.map((p) => (
              <div key={p.address}>
                <span className="mono">
                  {short(p.address)} · {p.curve ? 'curve' : 'pool'} · {((p.lpFeeBps + p.protocolFeeBps) / 100).toFixed(2)}%
                </span>
                <span className="mono">{sol(p.liquiditySol, 1)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
