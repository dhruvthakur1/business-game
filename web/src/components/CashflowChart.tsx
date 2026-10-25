import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { CashflowDay } from '../api/types';
import { compact, dec } from '../lib/format';
import { Card } from './ui';

/** Validated against the dark panel surface (dataviz validator: lightness, chroma, CVD, contrast all pass). */
const REVENUE = '#3d8ee6';
const COSTS = '#b47a20';
const REFRESH_MS = 30_000;

const dayLabel = (offset: number) => (offset === 0 ? 'Today' : offset === 1 ? 'Yesterday' : `${offset}d ago`);

/** Revenue vs operating costs per game day for the last seven days, from the server ledger. */
export function CashflowChart() {
  const [days, setDays] = useState<CashflowDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setDays((await api<{ days: CashflowDay[] }>('/cashflow')).days);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else throw err;
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const legend = (
    <div className="row small" style={{ gap: 14 }} aria-hidden="true">
      <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: REVENUE }} />Revenue</span>
      <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: COSTS }} />Operating costs</span>
    </div>
  );

  if (!days) {
    return (
      <Card className="main" title="Cash flow · last 7 game days" action={legend}>
        <p className={error ? 'loss' : 'muted'}>{error ?? 'Loading…'}</p>
      </Card>
    );
  }

  const max = Math.max(1, ...days.map((d) => Math.max(d.revenueCents, d.costsCents)));
  // Round the scale up to a clean number so the gridline label reads well.
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const today = days[days.length - 1].day;
  const total = days.reduce((s, d) => s + d.revenueCents - d.costsCents, 0);
  const shown = hover !== null ? days[hover] : null;

  return (
    <Card className="main" title="Cash flow · last 7 game days" action={legend}>
      <div className="row-between small muted" style={{ minHeight: 20 }}>
        {shown ? (
          <span>
            <strong style={{ color: 'var(--text)' }}>{dayLabel(today - shown.day)}</strong> · revenue {dec(shown.revenueCents / 100)} CR · costs {dec(shown.costsCents / 100)} CR ·
            net <span className={shown.revenueCents >= shown.costsCents ? 'gain' : 'loss'}>{shown.revenueCents >= shown.costsCents ? '+' : '−'}{dec(Math.abs(shown.revenueCents - shown.costsCents) / 100)}</span>
          </span>
        ) : (
          <span>7-day net <span className={total >= 0 ? 'gain' : 'loss'}>{total >= 0 ? '+' : '−'}{dec(Math.abs(total) / 100)} CR</span> · hover a day for details</span>
        )}
      </div>
      <div style={{ position: 'relative', height: 180 }}>
        <div aria-hidden="true" style={{ position: 'absolute', inset: '0 0 auto 0', borderTop: '1px dashed var(--line)' }} />
        <span aria-hidden="true" className="mono muted" style={{ position: 'absolute', top: 2, right: 0, fontSize: 11 }}>{compact(top / 100)}</span>
        <div
          role="img"
          aria-label={`Revenue and operating costs per day for the last seven game days. 7-day net ${dec(total / 100)} CR.`}
          style={{ display: 'grid', gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`, gap: 12, alignItems: 'end', height: '100%', borderBottom: '1px solid var(--line-strong)' }}
        >
          {days.map((d, i) => (
            <div
              key={d.day}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              style={{ display: 'flex', gap: 2, alignItems: 'flex-end', justifyContent: 'center', height: '100%', cursor: 'default', background: hover === i ? 'var(--line-soft)' : 'transparent', borderRadius: 6 }}
            >
              <div style={{ width: '34%', height: `${(d.revenueCents / top) * 100}%`, minHeight: d.revenueCents ? 2 : 0, background: REVENUE, borderRadius: '4px 4px 0 0' }} />
              <div style={{ width: '34%', height: `${(d.costsCents / top) * 100}%`, minHeight: d.costsCents ? 2 : 0, background: COSTS, borderRadius: '4px 4px 0 0' }} />
            </div>
          ))}
        </div>
      </div>
      <div aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`, gap: 12 }}>
        {days.map((d) => <span key={d.day} className="small muted" style={{ textAlign: 'center' }}>{dayLabel(today - d.day)}</span>)}
      </div>
      <table className="sr-only">
        <caption>Cash flow by game day</caption>
        <thead><tr><th>Day</th><th>Revenue (CR)</th><th>Operating costs (CR)</th></tr></thead>
        <tbody>
          {days.map((d) => <tr key={d.day}><td>{dayLabel(today - d.day)}</td><td>{dec(d.revenueCents / 100)}</td><td>{dec(d.costsCents / 100)}</td></tr>)}
        </tbody>
      </table>
    </Card>
  );
}
