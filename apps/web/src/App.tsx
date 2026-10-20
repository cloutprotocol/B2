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
                  <small>on Bordrless</small>
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
              </footer>
            </div>
          </MarketProvider>
        </WalletKitProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
