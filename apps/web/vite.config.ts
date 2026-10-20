import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The indexer (apps/indexer) serves /api and the RPC proxy /rpc; in development Vite forwards both to it.
const INDEXER = process.env.B2_INDEXER ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  // One copy of React and of the wallet context, or the wallet modal reads a context nobody provides.
  resolve: { dedupe: ['react', 'react-dom', '@solana/wallet-adapter-react'] },
  server: { port: 5173, proxy: { '/api': INDEXER, '/rpc': INDEXER } },
});
