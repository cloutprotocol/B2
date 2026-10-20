import { useMemo, useRef } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { MarketProvider, useMarket } from './market';
import { compact, usd } from './format';
import { SwapPage } from './pages/Swap';
import { ScannerPage } from './pages/Scanner';
import { TokenPage } from './pages/Token';
import { MachinePage } from './pages/Machine';
import { B2_COIN } from './api';
import { Logo } from './components/Logo';
import { ConnectButton, WalletKitProvider } from './components/WalletKit';

// The shell: wallet and market providers, the nav and the routes.

function Ticker() {
  const { overview } = useMarket();
  if (!overview) return null;
  return (
    <div className="ticker">
      <span>
        SOL <b>{usd(overview.solUsd)}</b>
      </span>
      <span>
        Tokens <b>{overview.tokens}</b>
      </span>
      <span>
        Liquidity <b>{compact(overview.liquiditySol)} SOL</b>
      </span>
      <span>
        24h vol <b>{usd(overview.volume24hUsd)}</b>
      </span>
    </div>
  );
}

export function App() {
  // The browser's RPC goes through the indexer, which holds the key and allows only what a swap needs.
  const endpoint = useMemo(() => `${window.location.origin}/rpc`, []);
  // the wallet's errors go to the connect modal, which says them in words
  const onWalletError = useRef<((e: Error) => void) | null>(null);
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={[]} autoConnect onError={(e) => onWalletError.current?.(e)}>
        <WalletKitProvider errorRef={onWalletError}>
          <MarketProvider>
            <div className="shell">
              <header className="top">
                <NavLink to="/" className="brand">
                  <Logo />
                  <small>Bordrless swap</small>
                </NavLink>
                <nav className="nav">
                  <NavLink to="/" end>
                    Swap
                  </NavLink>
                  <NavLink to="/scan">Scanner</NavLink>
                  <NavLink to={`/machine/${B2_COIN}`}>Machine</NavLink>
                </nav>
                <div className="spacer" />
                <Ticker />
                <ConnectButton />
              </header>
              <main>
                <Routes>
                  <Route path="/" element={<SwapPage />} />
                  <Route path="/scan" element={<ScannerPage />} />
                  <Route path="/token/:mint" element={<TokenPage />} />
                  <Route path="/machine/:mint" element={<MachinePage />} />
                </Routes>
              </main>
              <footer className="foot">
                <span>Read from Solana mainnet by the B² indexer; images, holders and 24 h volume from bordrless.app.</span>
                <span>Not financial advice. Bordrless programs are upgradeable by their team.</span>
                <a className="foot-gh" href="https://github.com/cloutprotocol/B2" target="_blank" rel="noopener noreferrer">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                  Open source on GitHub
                </a>
              </footer>
            </div>
          </MarketProvider>
        </WalletKitProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
