import { useEffect, useMemo, useRef, useState } from 'react';
import type { Token } from '../api';
import { compact, sol } from '../format';
import { TokenIcon } from './TokenIcon';

// Search every token the scanner knows, by symbol, name or mint; biggest first.

export function TokenPicker({ tokens, onPick, onClose }: { tokens: Token[]; onPick: (t: Token) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const hit = s ? tokens.filter((t) => t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s) || t.mint.toLowerCase() === s) : tokens;
    return hit.filter((t) => t.pool).slice(0, 200);
  }, [q, tokens]);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="label">Select a token</div>
          <input ref={input} placeholder="Symbol, name or mint address" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="modal-list">
          {list.map((t) => (
            <button key={t.mint} className="modal-row" onClick={() => onPick(t)}>
              <TokenIcon src={t.image} symbol={t.symbol} size={32} />
              <div className="grow">
                <div>
                  <b>{t.symbol}</b> {t.b2 ? <span className="chip dark">B²</span> : null}{' '}
                  {t.launch?.status === 'curve' ? <span className="chip">curve {Math.round(t.launch.progress * 100)}%</span> : null}
                </div>
                <div className="name">{t.name}</div>
              </div>
              <div className="mono num" style={{ textAlign: 'right', fontSize: 12 }}>
                <div>{sol(t.mcapSol, 1)}</div>
                <div className="muted">liq {compact(t.liquiditySol)}</div>
              </div>
            </button>
          ))}
          {list.length === 0 ? <div className="note" style={{ padding: 16 }}>No token matches.</div> : null}
        </div>
      </div>
    </div>
  );
}
