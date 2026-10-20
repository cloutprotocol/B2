import { useState } from 'react';

export function TokenIcon({ src, symbol, size = 28 }: { src: string | null | undefined; symbol: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <span className="icon" style={{ width: size, height: size }}>
        {symbol.slice(0, 2)}
      </span>
    );
  }
  return <img className="icon" src={src} alt="" width={size} height={size} loading="lazy" onError={() => setBroken(true)} />;
}

export const SOL_ICON = 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png';
