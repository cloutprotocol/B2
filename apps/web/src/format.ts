// Numbers as a scanner prints them.

const SUB = '₀₁₂₃₄₅₆₇₈₉';

/** A small price with its run of zeros folded: 0.0000231 -> 0.0₄231. */
export function price(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  if (v === 0) return '0';
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 4 });
  const zeros = Math.floor(-Math.log10(v));
  if (zeros < 4) return v.toFixed(zeros + digits);
  const sig = Math.round(v * 10 ** (zeros + digits)).toString().slice(0, digits);
  return `0.0${String(zeros)
    .split('')
    .map((d) => SUB[Number(d)])
    .join('')}${sig}`;
}

/** 1234567 -> 1.23M. */
export function compact(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(digits)}k`;
  return v.toFixed(a >= 100 ? 0 : a >= 1 ? digits : 4);
}

export const usd = (v: number | null | undefined) => (v === null || v === undefined || !isFinite(v) ? '—' : `$${compact(v)}`);
export const sol = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !isFinite(v) ? '—' : `${compact(v, d)} SOL`);

export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`;
}

export function age(unix: number): string {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

/** Base units -> whole tokens. */
export const whole = (units: string | bigint, decimals: number) => Number(units) / 10 ** decimals;

/** A typed amount -> base units, or null when it isn't a positive number. */
export function toUnits(text: string, decimals: number): bigint | null {
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') return null;
  const [i, f = ''] = text.split('.');
  const units = BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return units > 0n ? units : null;
}
