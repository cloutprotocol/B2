import type { IncomingMessage, ServerResponse } from 'node:http';
import { fresh, handle } from './app.ts';

// The indexer as a Vercel Function (bundled by scripts/vercel-build.mjs). Vercel's routes send
// `/api/<path>` and `/rpc` here as `?__p=<path>`; the original path is put back before the app reads it.
// The market refreshes on demand (fresh()); the RPC proxy never waits for it.

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://local');
  const path = url.searchParams.get('__p');
  if (path !== null) {
    url.searchParams.delete('__p');
    req.url = `/${path.replace(/^\/+/, '')}${url.search}`;
  }
  if (req.url?.startsWith('/api/')) await fresh();
  return handle(req, res);
}
