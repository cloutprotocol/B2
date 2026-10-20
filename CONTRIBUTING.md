# Contributing to B²

Thanks for helping. Issues and pull requests are welcome.

## Setup

```sh
cp .env.example .env      # set B2_RPC to a mainnet RPC URL that serves getProgramAccounts
npm install               # Node 22+
npm run dev               # indexer on :8787, web on http://localhost:5173
```

The program (`programs/b2`) has its own toolchain (Rust, Anchor 1.2, Agave's `cargo build-sbf`); see
[`programs/b2/README.md`](programs/b2/README.md).

## Before you open a pull request

- `npm run typecheck` passes for both apps.
- `npm run build` builds the web app, and `npm run vercel-build` the full deploy output.
- UI changes are checked at desktop width and at 390 px. Every control fits, nothing overflows.
- Program changes pass `programs/b2/scripts/build.sh` (including the Workshop source checks) and
  `cargo test --release -p bordr-pair-tests`.
- No secrets in the diff: no `.env`, no keypairs, no RPC URLs with keys.

## Style

- Match the code around you: its naming, its comment voice (short, plain sentences saying why), its idioms.
- Keep chain reads in `packages/core`, HTTP in `apps/indexer/src/app.ts`, and UI in `apps/web`.
- Say numbers as the chain has them; don't round a fee or a guard in copy.

## Reporting bugs

Open an issue with:
- what you did;
- what you expected, and what happened;
- the mint or transaction signature involved, if any.

For security issues, follow [SECURITY.md](SECURITY.md) instead.
