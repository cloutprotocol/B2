// Builds real routes and simulates them on mainnet for wallets that can afford them (no signatures:
// sigVerify off, the blockhash replaced). Run: B2_RPC=<url> npx tsx scripts/simulate-routes.ts
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { decodeHolding, holdingAddress } from '@bordrless/sdk';
import { BRIDGED_SOL_MINT, bestRoute, bordrless, feeConfig, prepareRoute, readMarket, type FeeConfig, type TokenFees } from '../src/index.ts';

const conn = new Connection(process.env.B2_RPC!, 'confirmed');
const SOL = BRIDGED_SOL_MINT.toBase58();
const market = await readMarket(conn);
const launches = await bordrless.launches();
const fees = new Map<string, TokenFees>();
for (const t of market.tokens) {
  const l = launches.find((x) => x.mint === t.mint);
  const rules = l?.customHook?.workshop?.reading?.rules ?? [];
  const hookBps = (on: string) => rules.filter((r) => r.on === on && r.to !== 'none').reduce((a, r) => Math.max(a, r.bps), 0);
  fees.set(t.mint, { mint: t.mint, decimals: t.decimals, launch: t.launch, buyFeeBps: l?.buyFeeBps ?? null, sellFeeBps: l?.sellFeeBps ?? null, hookBuyBps: hookBps('buy'), hookSellBps: hookBps('sell') });
}
const bySymbol = (s: string) => market.tokens.find((t) => t.symbol === s)!.mint;

async function holderOf(mint: string): Promise<{ owner: string; half: bigint }> {
  // A launch's buyers from Bordrless; any other token's from the signers of its pool's recent trades.
  let traders: string[];
  if (fees.get(mint)?.launch) traders = (await bordrless.trades(mint)).trades.filter((x) => x.side === 'buy').map((t) => t.trader);
  else {
    const pool = market.pools.find((p) => p.baseMint === mint)!;
    const sigs = await conn.getSignaturesForAddress(new PublicKey(pool.address), { limit: 25 });
    const txs = await Promise.all(sigs.filter((s) => !s.err).map((s) => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 })));
    traders = [...new Set(txs.flatMap((t) => (t ? [t.transaction.message.staticAccountKeys[0].toBase58()] : [])))];
  }
  for (const trader of traders) {
    const h = await conn.getAccountInfo(holdingAddress(new PublicKey(mint), new PublicKey(trader)));
    if (h && decodeHolding(h.data).amount > 1_000_000n) return { owner: trader, half: decodeHolding(h.data).amount / 2n };
  }
  throw new Error(`no holder found for ${mint}`);
}

async function balanceOf(owner: PublicKey, mint: string): Promise<bigint> {
  if (mint === SOL) return BigInt(await conn.getBalance(owner));
  const h = await conn.getAccountInfo(holdingAddress(new PublicKey(mint), owner));
  return h ? decodeHolding(h.data).amount : 0n;
}

async function run(name: string, inMint: string, outMint: string, amount: bigint, owner: string, fee: FeeConfig) {
  const trader = new PublicKey(owner);
  const route = bestRoute({ pools: market.pools, fees, inMint, outMint, amountIn: amount, slippageBps: 300, fee });
  if (!route) return console.log(`${name}: no route`);
  const prep = await prepareRoute(conn, trader, route, fee);
  const outAddr = outMint === SOL ? trader : holdingAddress(new PublicKey(outMint), trader);
  const before = await balanceOf(trader, outMint);
  for (const t of prep.transactions) {
    const tx = VersionedTransaction.deserialize(Buffer.from(t.transaction, 'base64'));
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: [outAddr.toBase58()] } });
    const acct = sim.value.accounts?.[0];
    let after: bigint | null = null;
    if (acct) after = outMint === SOL ? BigInt(acct.lamports) : decodeHolding(Buffer.from(acct.data[0], 'base64')).amount;
    const got = after !== null ? after - before : null;
    console.log(
      `${name} [${t.label}] ${sim.value.err ? 'FAILED ' + JSON.stringify(sim.value.err) : 'ok'} · ${sim.value.unitsConsumed} CU · ${tx.serialize().length} bytes` +
        ` · quoted ${route.amountOut} min ${route.minAmountOut} · simulated ${got ?? '?'} · legs ${route.legs.map((l) => `${l.side}${l.launch ? '(launch)' : ''}`).join(' → ')} · router fee ${route.routerFee}`,
    );
    if (sim.value.err) console.log((sim.value.logs ?? []).slice(-8).join('\n'));
    if (prep.transactions.length > 1) break; // later legs need the earlier one landed
  }
}

const WHALE = '5xsibKwtiN6ruxsYrEyWVpV3KcwuzSPbQd1n28a7spEd';
const FEE: FeeConfig = await feeConfig(conn, new PublicKey('ArUuTuvnezADKKqnwz3QCrmCP9qN7PuWKNqhRHMfXyD4'), 50);
console.log(`fee wallet ${FEE.wallet.toBase58()} · ${FEE.bps} bps · bridged legs ${FEE.bridged ? 'on' : 'off'}`);
const B2 = '4iWwcHf9tH6J6UjRgG9rXosXVxNdcKUFuqh1rbps6H7J';
const b2Holder = await holderOf(B2);

await run('buy B²', SOL, B2, 50_000_000n, WHALE, null);
await run('buy B² + fee', SOL, B2, 50_000_000n, WHALE, FEE);
await run('sell B²', B2, SOL, b2Holder.half, b2Holder.owner, null);
await run('sell B² + fee', B2, SOL, b2Holder.half, b2Holder.owner, FEE);
await run('buy CHM (kit, companion)', SOL, bySymbol('CHM'), 50_000_000n, WHALE, FEE);
await run('buy BCAT (burn, holders)', SOL, '5xpzVZYLvY7Fg29vUTgM5hJvECBZfYWVz2m8E7rJspwi', 50_000_000n, WHALE, FEE);
await run('buy LUCK (game hook)', SOL, bySymbol('LUCK'), 50_000_000n, WHALE, FEE);
await run('buy hLife (custom hook)', SOL, bySymbol('hLife'), 50_000_000n, WHALE, FEE);
await run('buy wBORDR (plain pool)', SOL, bySymbol('BORDR'), 50_000_000n, WHALE, FEE);
await run('B² → CHM (via SOL)', B2, bySymbol('CHM'), b2Holder.half, b2Holder.owner, FEE);
await run('buy THE7O (pool in bridged SOL)', SOL, bySymbol('THE7O'), 20_000_000n, WHALE, null);
await run('buy THE7O + fee (bridged router)', SOL, bySymbol('THE7O'), 20_000_000n, WHALE, FEE);
const the7oHolder = await holderOf(bySymbol('THE7O'));
await run('sell THE7O + fee (bridged router)', bySymbol('THE7O'), SOL, the7oHolder.half, the7oHolder.owner, FEE);
await run('buy P29KQ5 (another program\'s curve)', SOL, bySymbol('P29KQ5'), 5_000_000n, WHALE, FEE);
