import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

// The indexer as a long-running server (development, or any host that keeps a process up): it loads
// the repo's .env, then refreshes the market every 15 s and the enrichment every minute on timers.
// Vercel runs the same app as a function instead (vercel.ts).

const root = new URL('../../../.env', import.meta.url).pathname;
if (existsSync(root)) process.loadEnvFile(root);
if (!process.env.B2_RPC) {
  console.error('B2_RPC is not set: copy .env.example to .env and give it a mainnet RPC URL.');
  process.exit(1);
}
// imported after the environment is loaded: app.ts reads it once, at import
const app = await import('./app.ts');
const PORT = Number(process.env.PORT ?? 8787);

createServer(app.handle).listen(PORT, () => console.log(`b2 indexer on http://localhost:${PORT}`));

await Promise.all([app.refreshMarket(), app.refreshEnrichment()]);
setInterval(app.refreshMarket, 15_000);
setInterval(app.refreshEnrichment, 60_000);
