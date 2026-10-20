import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useWallet, type Wallet } from '@solana/wallet-adapter-react';
import { WalletReadyState, type WalletName } from '@solana/wallet-adapter-base';
import { Cube } from './Logo';

// B²'s own wallet connect: the modal (the spinning cube, the wallets this browser has first, what each
// step is waiting on, errors in words) and the header's button (connect, or the wallet with a menu).
// It drives @solana/wallet-adapter-react directly; nothing here ever sees a key.

type Kit = { open: () => void; close: () => void; visible: boolean; fail: (e: Error) => void };
const KitContext = createContext<Kit | null>(null);

/** Open the connect modal from anywhere (the swap card's button, the header). */
export function useConnectModal(): Kit {
  const kit = useContext(KitContext);
  if (!kit) throw new Error('useConnectModal outside WalletKitProvider');
  return kit;
}

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const installed = (w: Wallet) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable;

/** Wallet errors as a person would say them. */
function plain(e: Error, name: string | null): string {
  const m = `${e.name} ${e.message}`.toLowerCase();
  if (m.includes('reject') || m.includes('declin') || m.includes('cancel')) return `The request was declined in ${name ?? 'your wallet'}.`;
  if (m.includes('notready') || m.includes('not ready') || m.includes('not installed')) return `${name ?? 'That wallet'} isn't available in this browser.`;
  if (m.includes('locked')) return `Unlock ${name ?? 'your wallet'} and try again.`;
  return e.message || `${name ?? 'The wallet'} couldn't connect. Try again.`;
}

export function WalletKitProvider({ children, errorRef }: { children: ReactNode; errorRef: { current: ((e: Error) => void) | null } }) {
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { wallet } = useWallet();
  const fail = useCallback((e: Error) => setError(plain(e, wallet?.adapter.name ?? null)), [wallet]);
  // the WalletProvider's onError lands here
  useEffect(() => {
    errorRef.current = fail;
  }, [fail, errorRef]);
  const kit = useMemo<Kit>(() => ({ visible, open: () => (setError(null), setVisible(true)), close: () => setVisible(false), fail }), [visible, fail]);
  return (
    <KitContext.Provider value={kit}>
      {children}
      {visible ? <ConnectModal error={error} clearError={() => setError(null)} /> : null}
    </KitContext.Provider>
  );
}

function ConnectModal({ error, clearError }: { error: string | null; clearError: () => void }) {
  const { wallets, select, wallet, connecting, connected, connect } = useWallet();
  const { close } = useConnectModal();
  const [more, setMore] = useState(false);
  const [picked, setPicked] = useState<WalletName | null>(null);
  const card = useRef<HTMLDivElement>(null);

  const ready = wallets.filter(installed);
  const others = wallets.filter((w) => !installed(w));

  // done: close as soon as the wallet says yes
  useEffect(() => {
    if (connected && picked) close();
  }, [connected, picked, close]);
  // a wallet picked a second time (or picked again after a refusal) is asked again
  useEffect(() => {
    if (picked && wallet?.adapter.name === picked && !connected && !connecting && !error) connect().catch(() => {});
  }, [picked, wallet]);
  // Escape closes; focus starts in the dialog
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    card.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [close]);

  const pick = (w: Wallet) => {
    clearError();
    if (!installed(w)) {
      window.open(w.adapter.url, '_blank', 'noopener,noreferrer');
      return;
    }
    setPicked(w.adapter.name);
    select(w.adapter.name);
  };

  const row = (w: Wallet) => {
    const busy = picked === w.adapter.name && connecting;
    const failed = picked === w.adapter.name && !!error;
    return (
      <button key={w.adapter.name} type="button" className={`wk-row${busy ? ' is-busy' : ''}${failed ? ' is-failed' : ''}`} onClick={() => pick(w)} disabled={connecting && !busy}>
        <img src={w.adapter.icon} alt="" className="wk-icon" />
        <span className="wk-name">
          {w.adapter.name}
          {busy ? <small>Approve the connection in {w.adapter.name}…</small> : null}
        </span>
        {busy ? <span className="wk-spin" aria-label="Waiting for the wallet" /> : installed(w) ? <span className="wk-chip">Detected</span> : <span className="wk-chip is-out">Install ↗</span>}
      </button>
    );
  };

  return (
    <div className="wk-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="wk-card" role="dialog" aria-modal="true" aria-labelledby="wk-title" tabIndex={-1} ref={card}>
        <button type="button" className="wk-close" onClick={close} aria-label="Close">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="wk-hero">
          <div className="wk-cube">
            <Cube size={84} big />
          </div>
          <h2 id="wk-title">Connect to B²</h2>
          <p>Choose a Solana wallet. Your wallet signs every transaction; B² never sees your keys.</p>
        </div>

        <div className="wk-list">
          {ready.length ? ready.map(row) : <div className="wk-empty">No Solana wallet found in this browser.</div>}
        </div>
        {error ? (
          <div className="wk-error" role="alert">
            {error}
          </div>
        ) : null}

        {others.length ? (
          <>
            <button type="button" className="wk-more" onClick={() => setMore((v) => !v)} aria-expanded={more}>
              {more ? 'Fewer wallets' : `More wallets (${others.length})`}
            </button>
            {more ? <div className="wk-list">{others.map(row)}</div> : null}
          </>
        ) : null}

        <div className="wk-trust">
          <span>
            <i /> Solana mainnet
          </span>
          <span>Connecting shares only your public address</span>
        </div>
        {!ready.length ? (
          <a className="wk-new" href="https://phantom.com/download" target="_blank" rel="noopener noreferrer">
            New to Solana? Get Phantom ↗
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The header's button: Connect, or the connected wallet with a menu. */
export function ConnectButton() {
  const { publicKey, wallet, connected, connecting, disconnect } = useWallet();
  const { open } = useConnectModal();
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setMenu(false);
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menu]);

  if (!connected || !publicKey) {
    return (
      <button type="button" className="wk-connect" onClick={open} disabled={connecting}>
        <Cube size={22} />
        {connecting ? 'Connecting…' : 'Connect'}
      </button>
    );
  }
  const addr = publicKey.toBase58();
  return (
    <div className="wk-account" ref={ref}>
      <button type="button" className="wk-connect is-on" onClick={() => setMenu((v) => !v)} aria-expanded={menu} aria-haspopup="menu">
        {wallet ? <img src={wallet.adapter.icon} alt="" className="wk-icon is-sm" /> : null}
        <span className="mono">{short(addr)}</span>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {menu ? (
        <div className="wk-menu" role="menu">
          <div className="wk-menu-head">
            <span>{wallet?.adapter.name}</span>
            <span className="mono">{short(addr)}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              navigator.clipboard?.writeText(addr);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? 'Copied' : 'Copy address'}
          </button>
          <a role="menuitem" href={`https://solscan.io/account/${addr}`} target="_blank" rel="noopener noreferrer">
            View on Solscan ↗
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              open();
            }}
          >
            Change wallet
          </button>
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            onClick={() => {
              setMenu(false);
              disconnect().catch(() => {});
            }}
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}
