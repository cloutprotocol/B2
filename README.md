# B²

B² builds BORDR liquidity: a Bordrless Workshop pair (a hook and a companion script) that takes a 1%
SOL cut on every curve trade, buys the coin with it under a +3% guard, and at graduation seeds
coin/SOL and coin/wBORDR with the LP locked in the launch. This repo holds the program and the apps
around it: a swap for the whole Bordrless ecosystem, our own scanner, and a live machine view of B²
coins.

```
programs/b2      the Workshop pair as submitted and deployed (Rust, Anchor 1.2) and its LiteSVM tests
packages/core    TypeScript reads of the chain: every pool, mint, launch and bridged token; B²'s state
apps/indexer     the server: scans the market, enriches it, prepares swaps, proxies the browser's RPC
apps/web         the app: Swap, Scanner, token pages, Machine view (Vite + React + wallet adapter)
```

## Run it

```sh
cp .env.example .env      # give B2_RPC a mainnet RPC URL that serves getProgramAccounts
npm install               # Node 22+
npm run dev               # indexer on :8787, web on http://localhost:5173
```

`npm run typecheck` checks both apps; `npm run build` builds the web app into `apps/web/dist`.
The program has its own build and tests: `programs/b2/README.md`.

## How it reads the chain

- **Pools:** `getProgramAccounts` on the Bordrless DEX (411-byte pool accounts), decoded with
  `@bordrless/sdk`. Price is the books' `quoteReserve + virtualQuote` over `baseReserve + virtualBase`;
  a curve's liquidity is its real SOL only, a pool's both sides.
- **Tokens:** every mint the pools trade, priced by its deepest SOL pool. Market cap is price times
  supply; for a bridged token (wBORDR) the underlying SPL mint's supply.
- **Launches:** every launch account, for curve progress (`quoteReserve / graduationQuote`) and status.
- **B²:** the hook's `DipState` (`["state", mint]` under the hook), the script's `PairState`
  (`["script-state", mint]` under the companion program), the companion's SOL and held coin, and the
  `Stepped` events of every step. Layouts mirror `programs/b2`.
- **From bordrless.app/api** (public, no key): images, holders, 24 h volume and change, the rules,
  candles and trades. The indexer also records each pool's cumulative volume to compute its own 24 h
  figure once it has run a day.

## Swaps

Any token to any token (`packages/core/src/route.ts`, served as `/api/route/quote` and `/api/route/prepare`):

- **Routes:** every direct pool, and every path through one token both sides trade against (SOL,
  wBORDR, anything). The best output wins. A two-leg route is one transaction when it fits in 1,232
  bytes, else one per leg, signed as a batch; the second leg spends what the first is sure to deliver.
- **Legs, all built here with the SDK:**
  - a launch's curve or pool through its launch keys (kit, custom hook and SOL cut resolved);
  - any other pool with each side's token hook and its pool hook resolved;
  - a pool quoted in bridged SOL wraps the input and unwraps what it delivers.
  
  coin/wBORDR is such a pool, so B² coins route through it as soon as it exists.
- **The router fee:** set `B2_FEE_WALLET` (and `B2_FEE_BPS`, 1 to 100, default 50) and the leg that
  moves SOL goes through Bordrless's router. A buy pays it from its input, a sell from the SOL it
  delivers; Bordrless keeps a fifth. On a native pool (`router.swapV2`) it's paid in SOL to the wallet,
  which must hold rent (about 0.001 SOL). On a pool quoted in bridged SOL (`router.swap`) it's paid in
  bridged SOL to the wallet's bridged SOL holding, before the sell unwraps; those legs carry the fee
  only once that holding exists (`token.createHolding`), which the indexer checks every minute.
- **Quotes:** constant product on each pool's books with that side's fees: a launch's whole buy or
  sell fee from Bordrless plus its hook's cut from the Workshop reading, or a pool's LP and protocol
  fee. Slippage sets each leg's minimum. A hook whose cut isn't in its reading (one with no Workshop
  reading) isn't in the quote, and the minimum protects the trade.
- **Fallback:** if a single launch leg can't be built here, Bordrless's own `/api/swap/prepare` builds it.

`packages/core/scripts/simulate-routes.ts` builds real routes and simulates them on mainnet for
wallets that can afford them. On 19 Oct 2026 all of these simulated successfully:
- B² buys and sells, with and without the router fee;
- launches with a kit, a burn, a game hook and a custom hook;
- wBORDR/SOL;
- a pool quoted in bridged SOL, buying and selling, with and without the router fee;
- another program's curve with its own pool hook;
- B² → CHM through SOL.

## Keys and secrets

- `.env` holds the RPC URL. It's gitignored, and the browser never sees it: the web app talks to
  `/rpc` on the indexer, which forwards only the calls a wallet swap needs.
- Program keypairs never go in the repo (`programs/b2/keys/` is gitignored).
