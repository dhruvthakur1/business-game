import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, toCr } from '../api/client';
import type { LeagueOverview, LeagueRow } from '../api/types';
import { TopBar } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { Card, LeagueBadge, ProgressBar, Segmented } from '../components/ui';
import { dec, duration, num } from '../lib/format';
import { formatMetric } from '../lib/metrics';
import { useGame } from '../state/game';
import { MAX_POINTS, TIERS } from '../../../shared/leagues';

const REFRESH_MS = 10_000;
const GRID = { display: 'grid', gridTemplateColumns: '56px minmax(0, 1fr) 130px 90px', gap: 12, alignItems: 'center' } as const;

function Divider({ label, color }: { label: string; color: string }) {
  return (
    <div className="row" style={{ gap: 10, padding: '6px 12px', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color, flexWrap: 'nowrap' }}>
      <span style={{ flex: 1, height: 1, background: color, opacity: 0.4 }} />
      {label}
      <span style={{ flex: 1, height: 1, background: color, opacity: 0.4 }} />
    </div>
  );
}

function Row({ rank, name, a, b, me, rankColor }: { rank: number; name: string; a: string; b: string; me?: boolean; rankColor?: string }) {
  return (
    <div aria-current={me ? 'true' : undefined} style={{ ...GRID, minHeight: 44, padding: '0 12px', borderRadius: 10, background: me ? 'var(--gold-wash)' : undefined, border: `1px solid ${me ? 'var(--gold-edge)' : 'transparent'}` }}>
      <span className="mono" style={{ fontWeight: 600, color: rankColor }}>#{rank}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name} {me && <span className="small muted">you</span>}</span>
      <span className="mono" style={{ textAlign: 'right' }}>{a}</span>
      <span className="mono" style={{ textAlign: 'right', fontSize: 13, color: 'var(--muted)' }}>{b}</span>
    </div>
  );
}

export function Leagues() {
  const { act, notify, timeScale, refresh } = useGame();
  const [data, setData] = useState<LeagueOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [board, setBoard] = useState<'league' | 'empire'>('league');
  const [devTools, setDevTools] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      setData(await api<LeagueOverview>('/leagues'));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else throw err;
    }
  }, []);

  useEffect(() => {
    void load();
    void api<{ devTools: boolean }>('/bank').then((b) => setDevTools(b.devTools)).catch(() => undefined);
    const t = window.setInterval(() => void load(), REFRESH_MS);
    const c = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(t);
      window.clearInterval(c);
    };
  }, [load]);

  if (!data) {
    return (
      <>
        <TopBar title="Leagues" subtitle="Weekly league of up to 30 companies in your division" />
        <p className={error ? 'loss' : 'muted'}>{error ?? 'Loading your league…'}</p>
      </>
    );
  }

  const n = data.groupSize;
  const tierIdx = TIERS.indexOf(data.tier);
  const nextTier = TIERS[tierIdx + 1];
  const prevTier = TIERS[tierIdx - 1];
  const inPromotion = data.me.rank <= data.promoteCount && data.me.points > 0;
  const inRelegation = data.relegateCount > 0 && data.me.rank > n - data.relegateCount;
  const gameMinutesLeft = Math.max(0, ((Date.parse(data.week.endsAt) - now) * timeScale) / 60_000);

  const closeWeekNow = async () => {
    const r = await act(() => api<{ closedWeek: number | null; promoted?: number; relegated?: number; nextWeek: number }>('/dev/close-week', { body: {} }));
    if (r) notify(`Week ${r.closedWeek} closed`, `${r.promoted ?? 0} promoted, ${r.relegated ?? 0} relegated. Week ${r.nextWeek} has started.`, 'info');
    await load();
    await refresh();
  };

  const rankColor = (s: LeagueRow) => (s.rank <= data.promoteCount && s.points > 0 ? 'var(--gain)' : data.relegateCount > 0 && s.rank > n - data.relegateCount ? 'var(--loss)' : undefined);

  return (
    <>
      <TopBar title="Leagues" subtitle={`Week ${data.week.number} · ${data.division.name} division · ${n} compan${n === 1 ? 'y' : 'ies'} in your group`} />

      <section className="split" style={{ alignItems: 'stretch' }}>
        <div className="card" style={{ flex: '2 1 420px', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 24, padding: 24 }}>
          <div style={{ width: 96, height: 96, borderRadius: 24, background: 'var(--goldl-bg)', color: 'var(--gold)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="trophy" size={52} />
          </div>
          <div className="stack-sm" style={{ flex: '1 1 260px' }}>
            <span className="row" style={{ gap: 8 }}><LeagueBadge league={data.tier} suffix={data.division.name} /></span>
            <span className="disp" style={{ fontSize: 30, fontWeight: 600 }}>
              You're #{data.me.rank} of {n}
              {inPromotion ? ' · in the promotion zone' : inRelegation ? ' · in the relegation zone' : ''}
            </span>
            <span className="muted">
              {data.above ? <><span className="mono" style={{ color: 'var(--text)' }}>{num(data.above.gap)} CR</span> of value added behind {data.above.name} (#{data.above.rank}). </> : 'Top of your group. '}
              {data.below ? <>{data.below.name} (#{data.below.rank}) is <span className="mono" style={{ color: 'var(--text)' }}>{num(data.below.gap)} CR</span> behind you.</> : ''}
              {n === 1 ? ' Your group fills up as more companies join your division and tier.' : ''}
            </span>
          </div>
        </div>
        <div className="card" style={{ flex: '1 1 260px', justifyContent: 'center', padding: 24, gap: 10 }}>
          <span className="muted" style={{ fontSize: 13 }}>Week ends in</span>
          <span className="mono" style={{ fontSize: 34, fontWeight: 600 }}>{duration(gameMinutesLeft)}</span>
          <span className="muted" style={{ fontSize: 13 }}>
            {nextTier ? `Top ${data.promoteCount} promote to ${nextTier}` : 'Tycoon is the top tier'}
            {prevTier && data.relegateCount > 0 ? ` · bottom ${data.relegateCount} drop to ${prevTier}` : prevTier ? '' : ' · nobody drops out of Bronze'}
          </span>
          {devTools && <button type="button" className="btn btn-ghost" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => void closeWeekNow()}>Close the week now (dev)</button>}
        </div>
      </section>

      <section className="split">
        <Card className="main" style={{ gap: 14 }}>
          <div className="row-between">
            <Segmented label="Board" value={board} onChange={setBoard} options={[{ value: 'league', label: 'My league' }, { value: 'empire', label: 'Empire value' }]} />
            <span className="muted" style={{ fontSize: 13 }}>
              {board === 'league' ? `Points = 1,000 × value added ÷ last week’s P90, capped at ${num(MAX_POINTS)}` : 'All player companies · conservative net worth'}
            </span>
          </div>
          <div className="scroll-x">
            <div style={{ minWidth: 480 }}>
              <div style={{ ...GRID, padding: '8px 12px', fontSize: 12, color: 'var(--muted)' }}>
                <span>Rank</span><span>Company</span><span style={{ textAlign: 'right' }}>{board === 'league' ? 'Value added' : 'Net worth'}</span><span style={{ textAlign: 'right' }}>{board === 'league' ? 'Points' : ''}</span>
              </div>
              {board === 'league'
                ? data.standings.map((s) => (
                    <div key={s.companyId}>
                      <Row rank={s.rank} name={s.name} a={num(s.metric)} b={num(s.points)} me={s.me} rankColor={rankColor(s)} />
                      {s.rank === data.promoteCount && nextTier && s.rank < n && <Divider label="Promotion line" color="var(--gain)" />}
                      {data.relegateCount > 0 && s.rank === n - data.relegateCount && <Divider label="Relegation line" color="var(--loss)" />}
                    </div>
                  ))
                : data.empire.map((e) => <Row key={e.companyId} rank={e.rank} name={e.name} a={num(e.value)} b="" me={e.me} />)}
            </div>
          </div>
        </Card>

        <div className="side stack">
          <div className="row-between" style={{ alignItems: 'baseline' }}>
            <h2 className="h-section">This week's contests</h2>
            <Link to="/app/contests/industry" style={{ fontWeight: 600 }}>Details &amp; rules →</Link>
          </div>
          {data.contests.map((c) => (
            <Link key={c.id} to={`/app/contests/${c.id}`} className="card" style={{ padding: 18, gap: 10, color: 'var(--text)' }}>
              <div className="row-between"><strong style={{ fontSize: 15 }}>{c.name}</strong><span className="mono goldtx">#{c.rank} of {c.of}</span></div>
              <span className="muted" style={{ fontSize: 13 }}>{c.eligible ? `${formatMetric(c.unit, c.metric)} · ${num(c.points)} pts` : c.reason}</span>
              <ProgressBar value={c.points / MAX_POINTS} size="thin" label={`${c.name} points`} />
              <span className="small muted">#1 wins: {c.topReward}</span>
            </Link>
          ))}
          <Card title="History" style={{ gap: 4 }}>
            {data.history.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Your first week is still running.</p>}
            {data.history.map((h) => (
              <div key={h.week} className="list-row">
                <span className="mono muted" style={{ width: 44 }}>W{h.week}</span>
                <span style={{ flex: 1 }}>{h.tier} · #{h.rank} of {h.of} · {num(h.points)} pts</span>
                <span className="small" style={{ color: h.outcome === 'promoted' ? 'var(--gain)' : h.outcome === 'relegated' ? 'var(--loss)' : 'var(--muted)' }}>
                  {h.outcome}{h.prizeCents ? ` · +${dec(toCr(h.prizeCents))}` : ''}
                </span>
              </div>
            ))}
            {data.trophies.length > 0 && (
              <div className="row" style={{ gap: 8, paddingTop: 10 }}>
                {data.trophies.slice(0, 6).map((t, i) => (
                  <span key={i} className="chip" style={{ background: t.kind === 'relegation' ? 'var(--loss-wash)' : 'var(--goldl-bg)', color: t.kind === 'relegation' ? 'var(--loss)' : 'var(--gold)' }}>{t.title}</span>
                ))}
              </div>
            )}
          </Card>
        </div>
      </section>
    </>
  );
}
