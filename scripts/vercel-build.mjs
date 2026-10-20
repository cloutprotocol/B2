// `npm run vercel-build`: the whole site as Vercel's Build Output API v3 (.vercel/output), so what ships
// is exactly what this script writes:
//
//   static/                 the web app (apps/web/dist)
//   functions/indexer.func  the indexer (apps/indexer/src/vercel.ts) bundled into one file with esbuild
//   config.json             /api/* and /rpc to the indexer, files as they are, every other path to the app
//
// Vercel runs it as the build command (vercel.json); `vercel build` runs it locally.
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
const out = `${root}.vercel/output`;
rmSync(out, { recursive: true, force: true });

// the web app
execSync('npm run build -w @b2/web', { cwd: root, stdio: 'inherit' });
cpSync(`${root}apps/web/dist`, `${out}/static`, { recursive: true });

// the indexer, one ES module with every dependency in it (and a `require` for the CommonJS ones)
const fn = `${out}/functions/indexer.func`;
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: [`${root}apps/indexer/src/vercel.ts`],
  outfile: `${fn}/dist/index.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: "import { createRequire as __b2Require } from 'node:module'; const require = __b2Require(import.meta.url);" },
  logLevel: 'warning',
});
// @bordrless/sdk reads its IDLs at run time from ../idl beside its code: the same layout here
cpSync(`${root}node_modules/@bordrless/sdk/idl`, `${fn}/idl`, { recursive: true });
writeFileSync(`${fn}/.vc-config.json`, JSON.stringify({ runtime: 'nodejs22.x', handler: 'dist/index.mjs', launcherType: 'Nodejs', maxDuration: 60 }, null, 2));

// the routes
writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/(api/.*)$', dest: '/indexer?__p=$1' },
        { src: '^/(rpc)$', dest: '/indexer?__p=$1' },
        { handle: 'filesystem' },
        { src: '/.*', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);
console.log('vercel build output: .vercel/output');
