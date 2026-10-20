// @bordrless/shared on npm (0.12.0 to 0.14.0) points its entry at src/index.ts, which isn't in the package (only
// dist/ is). Until a fixed release, point both Bordrless packages at their built dist/.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

for (const name of ['sdk', 'shared']) {
  const path = new URL(`../node_modules/@bordrless/${name}/package.json`, import.meta.url);
  if (!existsSync(path)) continue;
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.main = './dist/index.js';
  pkg.types = './dist/index.d.ts';
  pkg.exports = { '.': { types: './dist/index.d.ts', default: './dist/index.js' } };
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}
