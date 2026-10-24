import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, toCr } from '../api/client';
import type { ContestDetailResponse } from '../api/types';
import { TopBar } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { Card } from '../components/ui';
import { dec, duration, num } from '../lib/format';
import { formatMetric } from '../lib/metrics';
import { useGame } from '../state/game';
import { CHECKPOINT_POINTS, MAX_POINTS } from '../../../shared/leagues';

const REWARD_COLORS = ['var(--gold)', 'var(--silver-fg)', 'var(--t1-fg)', 'var(--muted)'];
const REFRESH_MS = 10_000;

export function Contests() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { timeScale } = useGame();
  const contestId = id ?? 'industry';
  const [data, setData] = useState<ContestDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      setData(await api<ContestDetailResponse>(`/contests/${contestId}`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else throw err;
    }
  }, [contestId]);

  useEffect(() => {
    setData(null);
    void load();
    const t = window.setInterval(() => void load(), REFRESH_MS);
    const c = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(t);
      window.clearInterval(c);
    };
  }, [load]);

  const chips = data ? [{ id: 'industry', name: 'Industry League', activeThisWeek: true }, ...data.rotation] : [];
  const left = data ? Math.max(0, ((Date.parse(data.week.endsAt) - now) * timeScale) / 60_000) : 0;

  return (
    <>
      <TopBar title="Contests" subtitle="Industry League + three rotating contests each week · scored from your real activity" />
      <Link to="/app/leagues" className="row small" style={{ gap: 6, marginTop: -8 }}><Icon name="back" size={16} />Back to Leagues</Link>

      {data && (
        <div role="tablist" aria-label="Contest" className="row" style={{ gap: 8 }}>
          {chips.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={x.id === contestId}
              className="option inline"
              style={{ borderRadius: 999, padding: '0 16px', minHeight: 44, fontWeight: 600, opacity: x.activeThisWeek ? 1 : 0.6 }}
              onClick={() => navigate(`/app/contests/${x.id}`, { replace: true })}
            >
              {x.name}
              <span className="small muted" style={{ fontWeight: 700 }}>{x.id === 'industry' ? 'permanent' : x.activeThisWeek ? 'this week' : 'rotating'}</span>
            </button>
          ))}
        </div>
      )}

      {!data && <p className={error ? 'loss' : 'muted'}>{error ?? 'Loading contest…'}</p>}

      {data && (
        <>
          <section className="card" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 28, padding: 28, alignItems: 'center', borderRadius: 20 }}>
            <div className="stack-sm" style={{ flex: '2 1 420px', gap: 10 }}>
              <span className="overline goldtx" style={{ fontWeight: 700 }}>
                {data.active ? `Week ${data.week.number} · ${data.division} division` : 'Not running this week'}
              </span>
              <h2 className="disp" style={{ fontSize: 38, fontWeight: 700, letterSpacing: -1 }}>{data.contest.name}</h2>
              <p className="muted" style={{ fontSize: 16, maxWidth: 620 }}>{data.contest.pitch}</p>
            </div>
            {data.me ? (
              <div style={{ flex: '1 1 260px', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                <div className="inset stack-sm" style={{ gap: 4 }}><span className="small muted">Your rank</span><span className="stat-value goldtx" style={{ fontSize: 26 }}>#{data.me.rank} <span className="muted" style={{ fontSize: 14 }}>of {data.me.of}</span></span></div>
                <div className="inset stack-sm" style={{ gap: 4 }}><span className="small muted">Points</span><span className="stat-value" style={{ fontSize: 26 }}>{num(data.me.points)}</span></div>
                <div className="inset row-between" style={{ gridColumn: 'span 2' }}><span className="small muted">Ends in</span><span className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{duration(left)}</span></div>
              </div>
            ) : (
              <div className="inset" style={{ flex: '1 1 260px' }}>
                <span className="muted">This contest is in the rotation. Next week: {data.nextWeek.join(', ')}.</span>
              </div>
            )}
          </section>

          {data.me && !data.me.eligible && (
            <div className="callout bad" role="status"><span className="loss" style={{ fontWeight: 700 }}>!</span><span>{data.me.reason}</span></div>
          )}

          <section className="split">
            <div className="main stack" style={{ gap: 24 }}>
              <Card title="How you score">
                <pre className="mono" style={{ margin: 0, background: 'var(--ground)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 16px', fontSize: 14, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{data.contest.formula}</pre>
                <span className="muted" style={{ fontSize: 13 }}>
                  Points = min({num(MAX_POINTS)}, 1,000 × your metric ÷ {formatMetric(data.contest.unit, data.p90)}), the {data.division} division’s 90th percentile last week (or a starting baseline until there is history).
                </span>
              </Card>
              {data.me && (
                <Card title="What counted for you" action={<span className="muted" style={{ fontSize: 13 }}>Live · {formatMetric(data.contest.unit, data.me.metric)}</span>} style={{ gap: 4 }}>
                  {data.me.lines.map((l) => (
                    <div key={l.what} className="list-row" style={{ fontSize: 14 }}>
                      <span aria-label={l.counted ? 'Counted' : 'Not counted'} style={{ width: 22, height: 22, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0, background: l.counted ? 'var(--gain-wash)' : 'var(--loss-wash)', color: l.counted ? 'var(--gain)' : 'var(--loss)' }}>
                        {l.counted ? '✓' : '×'}
                      </span>
                      <span className="stack-sm" style={{ flex: 1, gap: 2 }}><span>{l.what}</span><span className="small muted">{l.why}</span></span>
                      <span className={`mono ${l.counted ? '' : 'muted'}`}>{l.value}</span>
                    </div>
                  ))}
                </Card>
              )}
              <Card title="Rules & eligibility">
                <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-soft)', lineHeight: 1.6 }}>
                  {data.contest.rules.map((r) => <li key={r}>{r}</li>)}
                </ul>
              </Card>
            </div>

            <div className="side stack" style={{ gap: 24 }}>
              {data.active && (
                <Card title="Standings · your group" style={{ gap: 6 }}>
                  {data.standings.map((b) => (
                    <div key={b.companyId} style={{ display: 'grid', gridTemplateColumns: '52px minmax(0, 1fr) auto', gap: 10, alignItems: 'center', minHeight: 44, padding: '0 10px', borderRadius: 10, background: b.me ? 'var(--gold-wash)' : undefined, border: `1px solid ${b.me ? 'var(--gold-edge)' : 'transparent'}`, opacity: b.eligible ? 1 : 0.6 }}>
                      <span className="mono" style={{ fontWeight: 600 }}>#{b.rank}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}{b.me ? ' (you)' : ''}</span>
                      <span className="mono" style={{ fontSize: 13 }}>{num(b.points)}</span>
                    </div>
                  ))}
                </Card>
              )}
              <Card title="Rewards" style={{ gap: 10 }}>
                {data.contest.rewards.map((w, i) => (
                  <div key={w.band} className="inset row" style={{ padding: '12px 14px', flexWrap: 'nowrap', border: `1px solid ${i === 0 ? 'var(--gold-edge)' : 'transparent'}` }}>
                    <span className="mono small" style={{ minWidth: 92, fontWeight: 700, color: REWARD_COLORS[i] }}>{w.band}</span>
                    <span style={{ flex: 1 }}>{w.prize}</span>
                  </div>
                ))}
                <span className="small muted">
                  The CR prize is capped at min(25,000 × division multiplier, 5% of the division’s median weekly profit). {CHECKPOINT_POINTS}+ points earns a checkpoint cosmetic.
                </span>
                {data.lastResult && (
                  <span className="small" style={{ color: 'var(--info-soft)' }}>
                    Last time (week {data.lastResult.week}): #{data.lastResult.rank}, {num(data.lastResult.points)} pts{data.lastResult.reward ? ` · ${data.lastResult.reward}` : ''}{data.lastResult.prizeCents ? ` · +${dec(toCr(data.lastResult.prizeCents))} CR` : ''}
                  </span>
                )}
              </Card>
            </div>
          </section>

          <Card title="Season calendar">
            <div className="grid-auto">
              <div className="inset stack-sm" style={{ gap: 4 }}><span className="mono small goldtx">EVERY WEEK</span><strong>Industry League + 3 rotating contests</strong><span className="small muted">Next week: {data.nextWeek.join(', ')}</span></div>
              <div className="inset stack-sm" style={{ gap: 4, opacity: 0.6 }}><span className="mono small" style={{ color: 'var(--diamond-fg)' }}>MONTHLY · not running yet</span><strong>Tycoon Championship, Sector Championship, Alliance War</strong><span className="small muted">Coming once there are enough Diamond+ companies</span></div>
              <div className="inset stack-sm" style={{ gap: 4, opacity: 0.6 }}><span className="mono small" style={{ color: 'var(--tycoon-fg)' }}>YEARLY · not running yet</span><strong>Hall of Entrepreneurs</strong><span className="small muted">Tycoon of the Year needs 40+ active weeks</span></div>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
