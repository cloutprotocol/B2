import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loading, Retry } from '../components/Retry';
import { usePoll, type Pool, type Token } from '../api';
import { age, compact, pct, price, short, sol, usd } from '../format';
import { useMarket } from '../market';
import { TokenIcon } from '../components/TokenIcon';

// The scanner: every token and every pool on the Bordrless DEX, read from chain, sortable and
// filterable like a screener.

type Filter = 'all' | 'curve' | 'graduated' | 'b2' | 'hooks' | 'bridged';
type Col = 'mcap' | 'price' | 'change' | 'liq' | 'vol' | 'holders' | 'age' | 'progress';

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['curve', 'On curve'],
  ['graduated', 'Graduated'],
  ['b2', 'B²'],
  ['hooks', 'Custom hooks'],
  ['bridged', 'Bridged'],
];

const LAUNCH_HOOK = '1jcBymHxBjniZDhNPy51Vgm5Nz7pLUdxa9UBHc4TavC';

function hookLabel(t: Token): string | null {
  if (t.b2) return 'B²';
  if (t.companionTag) return t.companionTag;
  if (t.hookProgram && t.hookProgram !== LAUNCH_HOOK) return 'hook';
  return null;
}

function sortValue(t: Token, col: Col): number {
  switch (col) {
    case 'mcap':
      return t.mcapSol ?? -1;
    case 'price':
      return t.priceSol ?? -1;
    case 'change':
      return t.priceChange24h ?? -1e9;
    case 'liq':
      return t.liquiditySol;
    case 'vol':
      return t.volume24hUsd ?? -1;
    case 'holders':
      return t.holders ?? -1;
    case 'age':
      return -t.createdAt;
    case 'progress':
      return t.launch ? t.launch.progress : -1;
  }
}

function Spark({ data }: { data: number[] | null }) {
  if (!data || data.length < 2) return <span className="muted">—</span>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 80},${22 - ((v - min) / (max - min || 1)) * 20}`).join(' ');
  const up = data[data.length - 1] >= data[0];
  return (
    <svg width="80" height="24" style={{ display: 'block', marginLeft: 'auto' }}>
      <polyline points={pts} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1.5" />
    </svg>
  );
}

function TokensTable({ rows, solUsd }: { rows: Token[]; solUsd: number | null }) {
  const nav = useNavigate();
  const [col, setCol] = useState<Col>('mcap');
  const [asc, setAsc] = useState(false);
  const sorted = useMemo(() => [...rows].sort((a, b) => (sortValue(a, col) - sortValue(b, col)) * (asc ? 1 : -1)), [rows, col, asc]);
  const th = (c: Col, label: string) => (
    <th onClick={() => (c === col ? setAsc(!asc) : (setCol(c), setAsc(false)))}>
      {label}
      {c === col ? (asc ? ' ↑' : ' ↓') : ''}
    </th>
  );
  return (
    <div className="table-wrap">
      <table className="grid tokens">
        <thead>
          <tr>
            <th className="l">#</th>
            <th className="l">Token</th>
            {th('price', 'Price')}
            {th('change', '24h')}
            <th>Chart</th>
            {th('mcap', 'Market cap')}
            {th('liq', 'Liquidity')}
            {th('vol', 'Volume 24h')}
            {th('holders', 'Holders')}
            {th('progress', 'Curve')}
            {th('age', 'Age')}
            <th />
          </tr>
        </thead>
        <tbody>
          {sorted.map((t, i) => {
            const hook = hookLabel(t);
            return (
              <tr key={t.mint} className="row" onClick={() => nav(`/token/${t.mint}`)}>
                <td className="l muted mono">{i + 1}</td>
                <td className="l">
                  <div className="tok">
                    <TokenIcon src={t.image} symbol={t.symbol} />
                    <div>
                      <div>
                        <b>{t.symbol}</b> {hook ? <span className={`chip ${t.b2 ? 'dark' : ''}`}>{hook}</span> : null}{' '}
                        {t.bridged ? <span className="chip">bridged</span> : null}
                      </div>
                      <div className="n">{t.name}</div>
                    </div>
                  </div>
                </td>
                <td className="mono">
                  <div>{price(t.priceSol)}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {t.priceSol && solUsd ? `$${price(t.priceSol * solUsd)}` : ''}
                  </div>
                </td>
                <td className={`mono ${(t.priceChange24h ?? 0) >= 0 ? 'up' : 'down'}`}>{pct(t.priceChange24h)}</td>
                <td>
                  <Spark data={t.spark} />
                </td>
                <td className="mono">
                  <div>{sol(t.mcapSol, 1)}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {t.mcapSol && solUsd ? usd(t.mcapSol * solUsd) : ''}
                  </div>
                </td>
                <td className="mono">{sol(t.liquiditySol, 1)}</td>
                <td className="mono">{usd(t.volume24hUsd)}</td>
                <td className="mono">{t.holders ?? '—'}</td>
                <td>
                  {t.launch ? (
                    t.launch.status === 'graduated' ? (
                      <span className="chip">graduated</span>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                        <div className="bar" style={{ width: 70 }}>
                          <i style={{ width: `${t.launch.progress * 100}%` }} />
                        </div>
                        <span className="mono" style={{ fontSize: 12, width: 36 }}>
                          {Math.round(t.launch.progress * 100)}%
                        </span>
                      </div>
                    )
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="mono muted">{age(t.createdAt)}</td>
                <td>
                  <button
                    className="btn"
                    style={{ padding: '4px 10px', fontSize: 11.5 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      nav(`/machine/${t.mint}`);
                    }}
                  >
                    Machine
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PoolsTable({ tokens }: { tokens: Token[] }) {
  const nav = useNavigate();
  const { data } = usePoll<{ pools: Pool[]; solUsd: number | null }>('/api/pools', 20_000);
  const sym = (m: string) => (m === 'A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i' ? 'SOL' : tokens.find((t) => t.mint === m)?.symbol ?? short(m));
  const pools = [...(data?.pools ?? [])].sort((a, b) => (b.liquiditySol ?? 0) - (a.liquiditySol ?? 0));
  return (
    <div className="table-wrap">
      <table className="grid pools">
        <thead>
          <tr>
            <th className="l">Pool</th>
            <th className="l">Address</th>
            <th>Kind</th>
            <th>Fee</th>
            <th>Base reserve</th>
            <th>Quote reserve</th>
            <th>Liquidity</th>
            <th>Volume 24h</th>
            <th>Swaps</th>
            <th>Last swap</th>
          </tr>
        </thead>
        <tbody>
          {pools.map((p) => (
            <tr key={p.address} className="row" onClick={() => nav(`/token/${p.baseMint}`)}>
              <td className="l">
                <b>{sym(p.baseMint)}</b> <span className="muted">/ {sym(p.quoteMint)}</span>
              </td>
              <td className="l mono muted">{short(p.address)}</td>
              <td>
                <span className="chip">{p.curve ? 'curve' : p.hookProgram ? 'hooked' : 'plain'}</span>
              </td>
              <td className="mono">{((p.lpFeeBps + p.protocolFeeBps) / 100).toFixed(2)}%</td>
              <td className="mono">{compact(Number(p.baseReserve) / 1e6)}</td>
              <td className="mono">{compact(Number(p.quoteReserve) / 1e9, 2)}</td>
              <td className="mono">{sol(p.liquiditySol, 1)}</td>
              <td className="mono">{usd(p.volume24hUsd)}</td>
              <td className="mono">{p.swapCount}</td>
              <td className="mono muted">{p.lastSwapAt ? age(p.lastSwapAt) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ScannerPage() {
  const { tokens, solUsd, overview, error, retryable, loading, retry } = useMarket();
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<'tokens' | 'pools'>('tokens');
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return tokens.filter((t) => {
      if (s && !(t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s) || t.mint.toLowerCase() === s)) return false;
      switch (filter) {
        case 'curve':
          return t.launch?.status === 'curve';
        case 'graduated':
          return t.launch?.status === 'graduated';
        case 'b2':
          return t.b2;
        case 'hooks':
          return hookLabel(t) !== null;
        case 'bridged':
          return t.bridged !== null;
        default:
          return true;
      }
    });
  }, [tokens, filter, q]);

  return (
    <div>
      {/* the market at a glance: four figures, each with its context */}
      <div className="hero-stats">
        <div className="hstat">
          <span className="label">Tokens</span>
          <span className="v">{overview?.tokens ?? '—'}</span>
          {overview && overview.tokens ? (
            <>
              <span className="split" aria-hidden>
                <i style={{ width: `${(overview.onCurve / overview.tokens) * 100}%` }} />
                <i className="g" style={{ width: `${(overview.graduated / overview.tokens) * 100}%` }} />
              </span>
              <span className="sub">
                <b>{overview.onCurve}</b> on curve · <b className="g">{overview.graduated}</b> graduated
              </span>
            </>
          ) : null}
        </div>
        <div className="hstat">
          <span className="label">Liquidity</span>
          <span className="v">{overview ? `${compact(overview.liquiditySol, overview.liquiditySol >= 1000 ? 2 : 0)} SOL` : '—'}</span>
          <span className="sub">{overview && solUsd ? `${usd(overview.liquiditySol * solUsd)} across every pool` : 'across every pool'}</span>
        </div>
        <div className="hstat">
          <span className="label">Volume 24h</span>
          <span className="v">{usd(overview?.volume24hUsd)}</span>
          <span className="sub">{overview && solUsd ? `≈ ${compact(overview.volume24hUsd / solUsd, 0)} SOL traded` : 'traded on the DEX'}</span>
        </div>
        <div className="hstat">
          <span className="label">SOL</span>
          <span className="v">{solUsd ? `$${solUsd.toFixed(2)}` : '—'}</span>
          <span className="sub">{overview ? `${overview.pools} pools on Bordrless` : 'Solana mainnet'}</span>
        </div>
      </div>

      <div className="scan-tools">
        <div className="tabs">
          <button className={view === 'tokens' ? 'on' : ''} onClick={() => setView('tokens')}>
            Tokens
          </button>
          <button className={view === 'pools' ? 'on' : ''} onClick={() => setView('pools')}>
            Pools
          </button>
        </div>
        {view === 'tokens' ? (
          <>
            <div className="tabs filters">
              {FILTERS.map(([f, label]) => (
                <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                  {label}
                </button>
              ))}
            </div>
            <input className="search" placeholder="Search symbol, name or mint" value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="label count">{rows.length} shown</span>
          </>
        ) : null}
      </div>
      {!tokens.length ? (
        error ? (
          <Retry title="The market didn't load" message={error} onRetry={retry} busy={loading} retryable={retryable} />
        ) : (
          <Loading text="Reading every Bordrless pool from chain…" />
        )
      ) : view === 'tokens' ? (
        <TokensTable rows={rows} solUsd={solUsd} />
      ) : (
        <PoolsTable tokens={tokens} />
      )}
    </div>
  );
}
