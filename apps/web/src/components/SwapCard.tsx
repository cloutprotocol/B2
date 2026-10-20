import { useCallback, useEffect, useMemo, useState } from 'react';
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { SOL_MINT, getJson, postJson, type Token } from '../api';
import { compact, price, toUnits, whole } from '../format';
import { useMarket } from '../market';
import { TokenIcon, SOL_ICON } from './TokenIcon';
import { TokenPicker } from './TokenPicker';

// A Uniswap-style card for any two tokens on the Bordrless DEX: the indexer finds the best route (a
// direct pool or one hop), builds every leg itself and puts Bordrless's router on the SOL leg. Exact
// input; a route that doesn't fit one transaction is signed as one batch and sent leg by leg.

const SLIPPAGES = [50, 100, 300];
type Status = { kind: 'idle' | 'busy' | 'done' | 'error'; text?: string; signature?: string };
type Leg = { pool: string; inMint: string; outMint: string; side: 'buy' | 'sell'; launch: boolean; amountIn: string; amountOut: string; minAmountOut: string; feeBps: number; priceImpactBps: number };
type RouteQuote = { amountIn: string; amountOut: string; minAmountOut: string; legs: Leg[]; routerFee: string; priceImpactBps: number; feeBps: number; error?: string };
type Prepared = { builder: 'b2' | 'bordrless'; transactions?: { transaction: string; version: 'legacy' | 'v0'; label: string; extraSigners?: string[] }[]; error?: string };
export type Swapped = { signature: string; side: 'buy' | 'sell'; sol: number; mint: string };

/** SOL as the picker lists it. */
export const SOL_TOKEN = { mint: SOL_MINT, name: 'Solana', symbol: 'SOL', decimals: 9, image: SOL_ICON, pool: 'native', priceSol: 1 } as unknown as Token;

async function confirm(connection: ReturnType<typeof useConnection>['connection'], signature: string) {
  // Poll rather than subscribe: the RPC proxy carries no websocket.
  for (let i = 0; i < 60; i++) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const s = value[0];
    if (s?.err) throw new Error('The transaction failed on chain.');
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('Not confirmed after 90 s: check the explorer.');
}

export function SwapCard({
  initialMint,
  compactCard,
  lockToken,
  onSwapped,
}: {
  initialMint?: string;
  compactCard?: boolean;
  lockToken?: boolean;
  onSwapped?: (s: Swapped) => void;
}) {
  const { tokens, solUsd } = useMarket();
  const { connection } = useConnection();
  const wallet = useWallet();
  const modal = useWalletModal();

  const [inMint, setInMint] = useState(SOL_MINT);
  const [outMint, setOutMint] = useState(initialMint ?? '');
  const [text, setText] = useState('');
  const [slippage, setSlippage] = useState(100);
  const [picking, setPicking] = useState<'in' | 'out' | null>(null);
  const [quote, setQuote] = useState<RouteQuote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [balances, setBalances] = useState<{ sol: string; tokens: Record<string, string> } | null>(null);

  useEffect(() => {
    setInMint(SOL_MINT);
    setOutMint(initialMint ?? '');
  }, [initialMint]);
  const all = useMemo(() => [SOL_TOKEN, ...tokens], [tokens]);
  const tokenOf = (m: string) => all.find((t) => t.mint === m) ?? null;
  const tIn = tokenOf(inMint);
  const tOut = tokenOf(outMint);
  const units = tIn ? toUnits(text, tIn.decimals) : null;

  const refreshBalances = useCallback(async () => {
    if (!wallet.publicKey) return setBalances(null);
    try {
      setBalances(await getJson(`/api/balance/${wallet.publicKey.toBase58()}?mints=${[inMint, outMint].filter(Boolean).join(',')}`));
    } catch {
      // Balances are a convenience.
    }
  }, [wallet.publicKey, inMint, outMint]);
  useEffect(() => {
    refreshBalances();
  }, [refreshBalances]);

  // Quote as the user types (debounced), and again every 10 s while the card shows one.
  useEffect(() => {
    setQuote(null);
    setQuoteErr(null);
    if (!tIn || !tOut || !units) return;
    let stop = false;
    const run = async () => {
      try {
        const q = await postJson<RouteQuote>('/api/route/quote', { inMint, outMint, amount: units.toString(), slippageBps: slippage });
        if (!stop) setQuote(q);
      } catch (e) {
        if (!stop) setQuoteErr((e as Error).message);
      }
    };
    const first = setTimeout(run, 350);
    const again = setInterval(run, 10_000);
    return () => {
      stop = true;
      clearTimeout(first);
      clearInterval(again);
    };
  }, [inMint, outMint, units?.toString(), slippage]);

  const bal = (m: string, t: Token | null) => (balances && t ? (m === SOL_MINT ? whole(balances.sol, 9) : whole(balances.tokens[m] ?? '0', t.decimals)) : null);
  const balanceIn = bal(inMint, tIn);
  const balanceOut = bal(outMint, tOut);
  const out = quote && tOut ? whole(quote.amountOut, tOut.decimals) : null;
  const minOut = quote && tOut ? whole(quote.minAmountOut, tOut.decimals) : null;
  const usdOf = (t: Token | null, amount: number | null) => (t && amount !== null && solUsd && t.priceSol ? amount * t.priceSol * solUsd : null);
  const inUsd = usdOf(tIn, units && tIn ? whole(units, tIn.decimals) : null);
  const short = balanceIn !== null && units !== null && tIn !== null && whole(units, tIn.decimals) > balanceIn;

  async function swap() {
    if (!wallet.publicKey || !wallet.signAllTransactions || !tIn || !tOut || !units) return;
    setStatus({ kind: 'busy', text: 'Preparing…' });
    try {
      const prep = await postJson<Prepared>('/api/route/prepare', { inMint, outMint, amount: units.toString(), slippageBps: slippage, owner: wallet.publicKey.toBase58() });
      const txs = (prep.transactions ?? []).map((p) => {
        if (p.extraSigners?.length) throw new Error('This trade needs another signer; open it on bordrless.app.');
        const raw = Buffer.from(p.transaction, 'base64');
        return p.version === 'v0' ? VersionedTransaction.deserialize(raw) : Transaction.from(raw);
      });
      setStatus({ kind: 'busy', text: txs.length > 1 ? `Sign ${txs.length} transactions in your wallet` : 'Sign in your wallet' });
      const signed = await wallet.signAllTransactions(txs);
      let last = '';
      for (const [i, s] of signed.entries()) {
        setStatus({ kind: 'busy', text: txs.length > 1 ? `Sending ${i + 1} of ${txs.length}…` : 'Sending…', signature: last || undefined });
        last = await connection.sendRawTransaction(s.serialize(), { skipPreflight: false, maxRetries: 3 });
        setStatus({ kind: 'busy', text: 'Confirming…', signature: last });
        await confirm(connection, last);
      }
      setStatus({ kind: 'done', text: 'Swapped.', signature: last });
      setText('');
      refreshBalances();
      const solSide = inMint === SOL_MINT ? whole(units, 9) : outMint === SOL_MINT ? out ?? 0 : (out ?? 0) * (tOut.priceSol ?? 0);
      onSwapped?.({ signature: last, side: inMint === SOL_MINT ? 'buy' : 'sell', sol: solSide, mint: inMint === SOL_MINT ? outMint : inMint });
    } catch (e) {
      const body = (e as { body?: { error?: string } }).body;
      setStatus({ kind: 'error', text: body?.error ?? (e as Error).message });
    }
  }

  const pick = (side: 'in' | 'out', t: Token | null) => {
    const locked = lockToken && t?.mint !== SOL_MINT;
    return (
      <button className={`pick ${t ? '' : 'empty'}`} onClick={() => !lockToken && setPicking(side)} style={{ cursor: lockToken ? 'default' : 'pointer' }}>
        {t ? (
          <>
            <TokenIcon src={t.image} symbol={t.symbol} size={24} /> {t.symbol} {lockToken || locked ? '' : '▾'}
          </>
        ) : (
          'Select token ▾'
        )}
      </button>
    );
  };

  let cta = 'Swap';
  let ctaDisabled = false;
  if (!wallet.connected) cta = 'Connect wallet';
  else if (!tIn || !tOut) [cta, ctaDisabled] = ['Select a token', true];
  else if (!units) [cta, ctaDisabled] = ['Enter an amount', true];
  else if (short) [cta, ctaDisabled] = [`Not enough ${tIn.symbol}`, true];
  else if (!quote) [cta, ctaDisabled] = [quoteErr ? 'No route' : 'Finding a route…', true];
  if (status.kind === 'busy') [cta, ctaDisabled] = [status.text ?? 'Working…', true];
  const sym = (m: string) => tokenOf(m)?.symbol ?? `${m.slice(0, 4)}…`;
  const hasB2 = quote?.legs.some((l) => tokenOf(l.side === 'buy' ? l.outMint : l.inMint)?.b2);

  return (
    <div className="card swap">
      <div className="swap-head">
        <h1>{compactCard ? 'Trade' : 'Swap'}</h1>
        <div className="slip" title="Slippage tolerance">
          {SLIPPAGES.map((s) => (
            <button key={s} className={slippage === s ? 'on' : ''} onClick={() => setSlippage(s)}>
              {s / 100}%
            </button>
          ))}
        </div>
      </div>

      <div className="leg">
        <div className="label">You pay</div>
        <div className="leg-row">
          <input inputMode="decimal" placeholder="0" value={text} onChange={(e) => setText(e.target.value.replace(',', '.'))} />
          {pick('in', tIn)}
        </div>
        <div className="leg-foot">
          <span>{inUsd ? `$${compact(inUsd)}` : ''}</span>
          {balanceIn !== null ? (
            <button
              className="mono"
              style={{ border: 'none', background: 'none', padding: 0, color: 'inherit' }}
              onClick={() => setText(String(inMint === SOL_MINT ? Math.max(0, balanceIn - 0.01) : balanceIn))}
            >
              Balance {compact(balanceIn, 4)} · max
            </button>
          ) : (
            <span />
          )}
        </div>
      </div>

      <button
        className="flip"
        onClick={() => {
          setInMint(outMint || SOL_MINT);
          setOutMint(inMint);
        }}
        aria-label="Switch sides"
      >
        ↓
      </button>

      <div className="leg">
        <div className="label">You receive</div>
        <div className="leg-row">
          <input readOnly placeholder="0" value={out === null ? '' : compact(out, 4)} />
          {pick('out', tOut)}
        </div>
        <div className="leg-foot">
          <span>{usdOf(tOut, out) ? `$${compact(usdOf(tOut, out)!)}` : ''}</span>
          <span>{balanceOut !== null ? `Balance ${compact(balanceOut, 4)}` : ''}</span>
        </div>
      </div>

      {quote && tIn && tOut && units && out ? (
        <div className="details">
          <div>
            <span>Rate</span>
            <span>
              1 {tOut.symbol} = {price(whole(units, tIn.decimals) / out)} {tIn.symbol}
            </span>
          </div>
          <div>
            <span>Route</span>
            <span className="route">
              {[quote.legs[0].inMint, ...quote.legs.map((l) => l.outMint)].map((m, i) => (
                <span key={i}>
                  {i ? <i>→ </i> : null}
                  {sym(m)}
                </span>
              ))}
            </span>
          </div>
          <div>
            <span>Fees on the way</span>
            <span>{quote.legs.map((l) => `${(l.feeBps / 100).toFixed(2)}%`).join(' + ')}</span>
          </div>
          {hasB2 ? (
            <div>
              <span>B² hook (SOL cut, to the pot)</span>
              <span>1%, buys 0% / sells 3% in a dip</span>
            </div>
          ) : null}
          {BigInt(quote.routerFee) > 0n ? (
            <div>
              <span>Router fee ({(quote.feeBps / 100).toFixed(2)}%)</span>
              <span>{compact(whole(quote.routerFee, 9), 5)} SOL</span>
            </div>
          ) : null}
          <div>
            <span>Price impact</span>
            <span className={quote.priceImpactBps > 300 ? 'down' : ''}>{(quote.priceImpactBps / 100).toFixed(2)}%</span>
          </div>
          <div>
            <span>Minimum received</span>
            <span>
              {compact(minOut ?? 0, 4)} {tOut.symbol}
            </span>
          </div>
          {quote.legs.length > 1 ? (
            <div>
              <span>Transactions</span>
              <span>one batch to sign; leg 2 spends what leg 1 is sure to deliver</span>
            </div>
          ) : null}
        </div>
      ) : null}
      {quoteErr ? <div className="note err">{quoteErr}</div> : null}

      <button className="cta" disabled={ctaDisabled} onClick={() => (wallet.connected ? swap() : modal.setVisible(true))}>
        {cta}
      </button>
      {status.kind === 'error' ? <div className="note err">{status.text}</div> : null}
      {status.signature ? (
        <div className="note">
          {status.kind === 'done' ? 'Swapped. ' : ''}
          <a href={`https://solscan.io/tx/${status.signature}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
            View on Solscan
          </a>
        </div>
      ) : null}
      {picking ? (
        <TokenPicker
          tokens={all}
          onPick={(t) => {
            if (picking === 'in') {
              if (t.mint === outMint) setOutMint(inMint);
              setInMint(t.mint);
            } else {
              if (t.mint === inMint) setInMint(outMint || SOL_MINT);
              setOutMint(t.mint);
            }
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </div>
  );
}
