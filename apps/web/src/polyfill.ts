// web3.js and the wallet adapters expect Node's Buffer as a global.
import { Buffer } from 'buffer';

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
