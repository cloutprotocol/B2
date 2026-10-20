# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[security advisories](https://github.com/cloutprotocol/B2/security/advisories/new) for this repository. Don't open a
public issue.

Include:
- what is affected (the program, the indexer or the web app);
- how to reproduce it;
- the impact you expect.

We'll acknowledge the report, work on a fix, and credit you if you'd like.

## Scope

- **In scope:**
  - `programs/b2`, the hook and companion script;
  - the indexer's API and its RPC proxy;
  - the web app's transaction building and wallet flow.
- **Out of scope:** the Bordrless programs themselves (report those to Bordrless), third-party wallets, and RPC
  providers.

## What the code never does

- **Keys:** handle a user's private key (wallets sign everything), or commit program keypairs.
- **RPC:**
  - expose the RPC URL to the browser;
  - forward a scanning RPC method from the browser (`/rpc` allows only what a wallet swap needs).
