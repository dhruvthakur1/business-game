import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TopBar } from '../components/AppShell';
import { buildingsToMap, PlotMap } from '../components/PlotMap';
import { Card, LeagueBadge, ProgressBar, Segmented, StatTile } from '../components/ui';
import { productById } from '../data/catalog';
import { CASHFLOW } from '../data/mock';
import type { Building } from '../data/types';
import { dec, duration, num, signed } from '../lib/format';
import { useGame } from '../state/game';
import { PLOT_COLS, PLOTS_PER_COMPANY } from '../../../shared/catalog';

const STATUS_COLOR: Record<Building['status'], string> = {
  ready: 'var(--gold)',
  running: 'var(--gain-soft)',
  idle: 'var(--muted)',
  construction: 'var(--info-soft)',
};

function statusText(b: Building) {
  if (b.status === 'running') return `Running · ${duration(b.minutesLeft)} left`;
  if (b.status === 'construction') return `Building ${Math.round(b.progress * 100)}%`;
  return b.status === 'ready' ? 'Ready' : 'Idle';
}

const TIER_TONE: Record<string, string> = { T0: 'var(--t0-fg)', T1: 'var(--t1-fg)', T2: 'var(--t2-fg)', T3: 'var(--t3-fg)', T4: 'var(--t4-fg)' };

const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function Headquarters() {
  const { me: state, cash, netWorth, operatingCashFlow7d, buildings, ready, collect, activity, company, inventory } = useGame();
  const [view, setView] = useState<'map' | 'list'>('map');
  const [collecting, setCollecting] = useState(false);
  const league = state?.league ?? null;
  const maxCash = Math.max(...CASHFLOW.map((d) => Math.max(d.revenue, d.costs))) * 1.08;
  const running = buildings.filter((b) => b.status === 'running');
  const rows = Math.max(1, Math.ceil(PLOTS_PER_COMPANY / PLOT_COLS));

  const doCollect = async () => {
    setCollecting(true);
    await collect();
    setCollecting(false);
  };

  return (
    <>
      <TopBar
        title="Headquarters"
        subtitle={ready.length ? `${ready.length} job${ready.length > 1 ? 's are' : ' is'} ready to collect.` : running.length ? 'All jobs are running.' : 'Start a job to get production going.'}
      />

      <section aria-label="Key numbers" className="grid-auto">
        <StatTile label="Cash on hand" value={num(cash)} valueClass="goldtx" deltaTone="muted" delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>{company?.name}</span>} />
        <StatTile
          label="7-day operating cash flow"
          value={signed(operatingCashFlow7d)}
          deltaTone="muted"
          delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Trading, NPC sales and op costs (game days)</span>}
        />
        <StatTile label="Conservative net worth" value={num(netWorth)} deltaTone="muted" delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Cash + goods at ref + 70% of buildings</span>} />
        <StatTile
          label="Debt"
          value={num(state ? state.debtCents / 100 : 0)}
          deltaTone="muted"
          delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Loans, overdraft and unpaid upkeep · <Link to="/app/bank">Bank</Link></span>}
        />
      </section>

      {state && state.upkeepArrearsCents > 0 && (
        <div className="callout bad" role="alert">
          <span className="loss" style={{ fontWeight: 700 }}>!</span>
          <span><strong className="loss">Unpaid upkeep: {dec(state.upkeepArrearsCents / 100)} CR.</strong> <span className="muted">Production is paused until it is paid. </span><Link to="/app/bank">Settle it at the bank</Link></span>
        </div>
      )}

      <section className="split">
        <Card
          className="main"
          title={`${(company?.region ?? 'north').replace(/^./, (c) => c.toUpperCase())} region · ${buildings.length} of ${PLOTS_PER_COMPANY} plots`}
          action={<Segmented label="View" value={view} onChange={setView} options={[{ value: 'map', label: 'Map' }, { value: 'list', label: 'List' }]} />}
        >
          {buildings.length === 0 ? (
            <div className="inset stack-sm" style={{ alignItems: 'flex-start' }}>
              <strong>No buildings yet</strong>
              <span className="muted">A Grain Farm costs 30,000 CR and supplies the whole food chain.</span>
              <Link to="/app/catalog" className="btn btn-primary">Build something</Link>
            </div>
          ) : view === 'map' ? (
            <>
              <div className="scroll-x" style={{ background: 'var(--sunken)', borderRadius: 12, padding: '24px 0 16px' }}>
                <PlotMap items={buildingsToMap(buildings)} cols={PLOT_COLS} rows={rows} />
              </div>
              <div className="row small muted" style={{ gap: 16 }}>
                {(['ready', 'running', 'idle'] as const).map((s) => (
                  <span key={s} className="row" style={{ gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: STATUS_COLOR[s] }} />
                    {s === 'idle' ? 'Idle (needs inputs or a start)' : s[0].toUpperCase() + s.slice(1)}
                  </span>
                ))}
                <Link to="/app/catalog" style={{ marginLeft: 'auto', fontWeight: 600 }}>+ Build</Link>
              </div>
            </>
          ) : (
            <div className="scroll-x">
              <table className="table" style={{ minWidth: 560 }}>
                <thead>
                  <tr><th>Building</th><th>Level</th><th>Status</th><th className="num">Est. net/day</th></tr>
                </thead>
                <tbody>
                  {buildings.map((b) => (
                    <tr key={b.id}>
                      <td><Link to={`/app/buildings/${b.id}`}>{b.name}</Link></td>
                      <td className="mono">{b.level}</td>
                      <td style={{ color: STATUS_COLOR[b.status] }}>{statusText(b)}</td>
                      <td className="num">{b.netPerDay ? signed(b.netPerDay) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="side stack" style={{ gap: 24 }}>
          <Card title="Ready to collect" action={<span className="mono muted">{ready.length}</span>}>
            {ready.length > 0 ? (
              <>
                <div className="stack-sm">
                  {ready.map((b) => {
                    const out = b.readyOutput;
                    const p = out ? productById(out.productId) : null;
                    return (
                      <div key={b.id} className="inset row-between" style={{ padding: '12px 14px' }}>
                        <span>{b.name}</span>
                        {out && p && (
                          <span className="mono" style={{ color: TIER_TONE[p.tier] ?? 'var(--text)' }}>
                            {num(out.qty)} {p.name.toLowerCase()} · Q{out.quality}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button type="button" className="btn btn-primary btn-lg" disabled={collecting} onClick={() => void doCollect()}>
                  {collecting ? 'Collecting…' : 'Collect all & restart jobs'}
                </button>
              </>
            ) : (
              <p className="muted">
                {running.length ? `Nothing to collect. Next job lands in ${duration(Math.min(...running.map((b) => b.minutesLeft)))} of game time.` : 'No jobs running.'}
              </p>
            )}
          </Card>

          <Card title="Warehouse" action={<Link to="/app/market" className="small" style={{ fontWeight: 600 }}>Trade →</Link>} style={{ gap: 4 }}>
            {inventory.length === 0 && <p className="muted">Empty. Buy inputs from the NPC vendor on the exchange.</p>}
            {inventory.map((lot) => {
              const p = productById(lot.productId);
              return (
                <div key={`${lot.productId}-${lot.quality}`} className="list-row">
                  {p.art ? <img src={p.art} alt="" width={24} height={24} /> : <span className="swatch" />}
                  <span style={{ flex: 1 }}>{p.name}</span>
                  <span className="mono muted">Q{lot.quality}</span>
                  <span className="mono" style={{ minWidth: 64, textAlign: 'right' }}>{num(lot.qty)}</span>
                </div>
              );
            })}
          </Card>

          <Card title="Industry League" action={league ? <LeagueBadge league={league.tier} suffix={league.division} /> : undefined}>
            {league ? (
              <>
                <div className="row" style={{ alignItems: 'baseline' }}>
                  <span className="mono" style={{ fontSize: 40, fontWeight: 600 }}>#{league.rank}</span>
                  <span className="muted">of {league.groupSize} · week {league.week}</span>
                </div>
                <ProgressBar value={league.groupSize > 1 ? (league.groupSize - league.rank) / (league.groupSize - 1) : 1} label="League position" />
                <span className="muted" style={{ fontSize: 13 }}>Ranked by value added from production this week.</span>
              </>
            ) : (
              <span className="muted">You’ll be placed in a league group within a few seconds.</span>
            )}
            <Link to="/app/leagues" style={{ fontWeight: 600 }}>Open league table →</Link>
          </Card>
        </div>
      </section>

      <section className="split">
        <Card
          className="main"
          title="Cash flow · last 7 days"
          action={<span className="chip" style={{ background: 'var(--line)', color: 'var(--text-soft)' }}>Sample data</span>}
        >
          <div
            role="img"
            aria-label="Sample revenue and cost bars for the last seven days"
            style={{ display: 'grid', gridTemplateColumns: `repeat(${CASHFLOW.length}, minmax(0, 1fr))`, gap: 12, alignItems: 'end', height: 180, borderBottom: '1px solid var(--line)' }}
          >
            {CASHFLOW.map((d) => (
              <div key={d.day} style={{ display: 'flex', gap: 4, alignItems: 'flex-end', justifyContent: 'center', height: '100%' }}>
                <div style={{ width: '40%', height: `${(d.revenue / maxCash) * 100}%`, background: 'var(--info)', borderRadius: '4px 4px 0 0' }} />
                <div style={{ width: '40%', height: `${(d.costs / maxCash) * 100}%`, background: '#3a4352', borderRadius: '4px 4px 0 0' }} />
              </div>
            ))}
          </div>
        </Card>

        <Card className="side" title="Ledger activity" style={{ gap: 4 }}>
          {activity.length === 0 && <p className="muted">No transactions yet.</p>}
          {activity.slice(0, 8).map((a) => (
            <div key={`${a.id}-${a.amountCents}`} className="list-row">
              <span className="mono muted" style={{ width: 44 }}>{timeLabel(a.at)}</span>
              <span style={{ flex: 1 }}>{a.memo}</span>
              <span className={`mono ${a.amountCents >= 0 ? 'gain' : 'loss'}`}>{a.amountCents >= 0 ? '+' : '−'}{dec(Math.abs(a.amountCents) / 100)}</span>
            </div>
          ))}
        </Card>
      </section>
    </>
  );
}
