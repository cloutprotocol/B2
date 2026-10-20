// `npm run dev`: the indexer and the web app together; Ctrl-C stops both.
import { spawn } from 'node:child_process';

const run = (ws) => spawn('npm', ['run', 'dev', '-w', ws], { stdio: 'inherit' });
const kids = [run('@b2/indexer'), run('@b2/web')];
const stop = () => kids.forEach((k) => k.kill('SIGINT'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
kids.forEach((k) => k.on('exit', (code) => code && (stop(), process.exit(code))));
