const nf = (min: number, max: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });

const int = nf(0, 0);
const two = nf(2, 2);

/** 248310 → "248,310" */
export const num = (n: number) => int.format(Math.round(n));

/** 8.3412 → "8.34" */
export const dec = (n: number) => two.format(n);

/** 1840200 → "1.84M", 61200 → "61.2k" */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${+(n / 1e3).toFixed(1)}k`;
  return num(n);
}

/** Signed with arrow for trends: 12.4 → "▲ +12.4%" */
export function trend(pct: number, digits = 1): string {
  return pct >= 0 ? `▲ +${pct.toFixed(digits)}%` : `▼ ${pct.toFixed(digits)}%`;
}

/** Signed credits: 4320 → "+4,320", -1718.65 → "−1,718.65" */
export function signed(n: number, decimals = 0): string {
  const body = decimals ? two.format(Math.abs(n)) : int.format(Math.abs(Math.round(n)));
  return `${n < 0 ? '−' : '+'}${body}`;
}

export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;

export const stars = (q: number) => '★'.repeat(q) + '☆'.repeat(5 - q);

export function duration(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = Math.round(minutes % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}
