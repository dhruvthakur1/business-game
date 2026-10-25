import type { CSSProperties, ReactNode } from 'react';
import type { LeagueName, SectorTag } from '../data/types';
import { stars } from '../lib/format';

/* ---------- Tier / league chips ---------- */

const TIER_LABEL: Record<SectorTag, string> = {
  T0: 'T0 Raw', T1: 'T1 Primary', T2: 'T2 Processed', T3: 'T3 Components', T4: 'T4 Consumer',
  T5: 'T5 Services', T6: 'T6 Capital', T7: 'T7 Luxury', Energy: 'Energy', Retail: 'Retail', Research: 'Research',
};

const tierVars = (tag: SectorTag): [string, string] => {
  if (tag === 'Research') return ['var(--info-wash)', 'var(--info-soft)'];
  if (tag === 'Energy') return ['var(--goldl-bg)', 'var(--gold)'];
  if (tag === 'Retail') return ['#0f2a20', 'var(--gain-soft)'];
  const k = tag.toLowerCase();
  return [`var(--${k}-bg)`, `var(--${k}-fg)`];
};

export function TierChip({ tier, short }: { tier: SectorTag; short?: boolean }) {
  const [bg, fg] = tierVars(tier);
  return (
    <span className="chip" style={{ background: bg, color: fg }}>
      {short ? tier : TIER_LABEL[tier]}
    </span>
  );
}

export const tierSwatch = (tier: SectorTag) => (tier === 'Research' ? 'var(--info-soft)' : tier === 'Energy' || tier === 'Retail' ? 'var(--gold)' : `var(--${tier.toLowerCase()})`);

const LEAGUE_VAR: Record<LeagueName, string> = {
  Bronze: 'bronze', Silver: 'silver', Gold: 'goldl', Platinum: 'platinum', Diamond: 'diamond', Master: 'master', Tycoon: 'tycoon',
};

export function LeagueBadge({ league, suffix }: { league: LeagueName; suffix?: string }) {
  const v = LEAGUE_VAR[league];
  return (
    <span className="chip pill" style={{ background: `var(--${v}-bg)`, color: `var(--${v}-fg)`, fontWeight: 700 }}>
      {league}
      {suffix ? ` · ${suffix}` : ''}
    </span>
  );
}

/* ---------- Data display ---------- */

export function StatTile(props: { label: string; value: ReactNode; delta?: ReactNode; deltaTone?: 'gain' | 'loss' | 'muted'; valueClass?: string }) {
  return (
    <div className="card stat" style={{ padding: '18px 20px', gap: 6 }}>
      <span className="stat-label">{props.label}</span>
      <span className={`stat-value ${props.valueClass ?? ''}`}>{props.value}</span>
      {props.delta != null && <span className={`stat-delta ${props.deltaTone ?? 'gain'}`}>{props.delta}</span>}
    </div>
  );
}

export function ProgressBar({ value, color, size, label }: { value: number; color?: string; size?: 'thin' | 'thick'; label?: string }) {
  const pctValue = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={`bar ${size ?? ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pctValue} aria-label={label}>
      <span style={{ width: `${pctValue}%`, background: color }} />
    </div>
  );
}

export function QualityStars({ q, showLabel = true }: { q: number; showLabel?: boolean }) {
  return (
    <span className="mono" aria-label={`Quality ${q} of 5`}>
      {showLabel && `Q${q} `}
      <span className="goldtx">{'★'.repeat(q)}</span>
      <span className="muted">{stars(q).slice(q)}</span>
    </span>
  );
}

export function RankGapPill({ rank, gapText, league }: { rank: number; gapText: string; league: LeagueName }) {
  return (
    <div className="row" style={{ gap: 12, background: 'var(--raised)', border: '1px solid var(--line-strong)', borderRadius: 999, padding: '8px 8px 8px 16px', flexWrap: 'nowrap' }}>
      <span className="mono" style={{ fontSize: 15, fontWeight: 600 }}>#{rank}</span>
      <span className="muted" style={{ flex: 1, fontSize: 13 }}>{gapText}</span>
      <LeagueBadge league={league} />
    </div>
  );
}

/* ---------- Controls ---------- */

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
}

export function Segmented<T extends string>(props: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  boxed?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div role="tablist" aria-label={props.label} className={`segmented ${props.boxed ? 'boxed' : ''}`} style={props.style}>
      {props.options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper(props: { value: ReactNode; onDec: () => void; onInc: () => void; decLabel: string; incLabel: string; invalid?: boolean }) {
  return (
    <div className="stepper">
      <button type="button" aria-label={props.decLabel} onClick={props.onDec}>−</button>
      <output style={props.invalid ? { borderColor: 'var(--loss)' } : undefined}>{props.value}</output>
      <button type="button" aria-label={props.incLabel} onClick={props.onInc}>+</button>
    </div>
  );
}

export function Card({ title, action, children, className, style }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <section className={`card ${className ?? ''}`} style={style}>
      {(title || action) && (
        <div className="row-between">
          {title && <h2 className="h-section">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Callout({ tone, title, children }: { tone: 'ok' | 'bad'; title: string; children?: ReactNode }) {
  return (
    <div className={`callout ${tone}`} role="status">
      <span className={tone === 'ok' ? 'gain' : 'loss'} style={{ fontWeight: 700 }}>{tone === 'ok' ? '✓' : '!'}</span>
      <div className="stack-sm" style={{ gap: 2 }}>
        <strong className={tone === 'ok' ? 'gain' : 'loss'}>{title}</strong>
        {children && <span className="muted" style={{ fontSize: 13 }}>{children}</span>}
      </div>
    </div>
  );
}

/** Wraps product art in its quality frame. */
export function QualityFrame({ q, children, style }: { q: number; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className={`qframe q${q}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 14, ...style }}>
      {children}
    </div>
  );
}
