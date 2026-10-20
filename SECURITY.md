# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[security advisories](https://github.com/cloutprotocol/B2/security/advisories/new) for this repository. Don't open a
public issue.

Include:
- what is affected (the swap's routing and transaction building, the indexer, the web app, or the B² pair);
- how to reproduce it;
- the impact you expect.

We'll acknowledge the report, work on a fix, and credit you if you'd like.

## Scope

- **In scope:**
  - the swap: routing, quotes and the transactions `packages/core` builds;
  - the indexer's API and its RPC proxy;
  - the web app's wallet flow;
  - `programs/b2`, the B² hook and companion script.
- **Out of scope:** the Bordrless programs themselves (report those to Bordrless), third-party wallets, and RPC
  providers.

## What the code never does

- **Keys:** handle a user's private key (wallets sign everything), or commit program keypairs.
- **RPC:**
  - expose the RPC URL to the browser;
  - forward a scanning RPC method from the browser (`/rpc` allows only what a wallet swap needs).
