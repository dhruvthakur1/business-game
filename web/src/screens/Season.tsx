import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { SeasonResponse } from '../api/types';
import { TopBar } from '../components/AppShell';
import { Card, ProgressBar, StatTile } from '../components/ui';
import { num } from '../lib/format';
import { useGame } from '../state/game';

const KIND_TONE: Record<string, string> = {
  wallet: 'var(--gold)',
  research: 'var(--info-soft)',
  livery: 'var(--gain-soft)',
  title: 'var(--master-fg)',
  trophy: 'var(--gold)',
};

export function Season() {
  const { act, notify, refresh } = useGame();
  const [data, setData] = useState<SeasonResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<SeasonResponse>('/season'));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else throw err;
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    const res = await act(fn);
    await load();
    await refresh();
    setBusy(false);
    return res;
  };

  if (!data) {
    return (
      <>
        <TopBar title="Season pass" subtitle="Earn XP this season to unlock rewards" />
        <p className={error ? 'loss' : 'muted'}>{error ?? 'Loading the season…'}</p>
      </>
    );
  }

  const intoTier = data.xp - data.tier * data.xpPerTier;
  const claim = async (tier?: number) => {
    const res = await run(() => api<{ claimed: { tier: number; label: string }[] }>('/season/claim', { body: tier ? { tier } : {} }));
    if (res && res.claimed.length) {
      notify(
        res.claimed.length === 1 ? `Tier ${res.claimed[0].tier} claimed` : `${res.claimed.length} rewards claimed`,
        res.claimed.length === 1 ? res.claimed[0].label : res.claimed.map((c) => c.label).slice(0, 4).join(' · ') + (res.claimed.length > 4 ? ' …' : ''),
      );
    }
  };
  const equip = async (title: string | null) => {
    const res = await run(() => api('/profile/title', { body: { title } }));
    if (res) notify(title ? 'Title equipped' : 'Title removed', title ?? 'No title shown under your company name.', 'info');
  };
  const titles = data.cosmetics.filter((c) => c.kind === 'title');
  const liveries = data.cosmetics.filter((c) => c.kind === 'livery');

  return (
    <>
      <TopBar title={`Season ${data.number} · ${data.name}`} subtitle={`${data.daysLeft} game day${data.daysLeft === 1 ? '' : 's'} left · XP you earn this season fills the pass`} />
      <section className="grid-auto">
        <StatTile label="Tier" value={<>{data.tier} <span className="muted" style={{ fontSize: 15 }}>/ {data.tiers}</span></>} deltaTone="muted" delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>{num(data.xp)} season XP</span>} />
        <div className="card stat" style={{ padding: '18px 20px', gap: 8 }}>
          <span className="stat-label">Next tier</span>
          {data.tier < data.tiers ? (
            <>
              <ProgressBar value={intoTier / data.xpPerTier} size="thick" label="Progress to the next tier" />
              <span className="mono small muted">{num(intoTier)} / {num(data.xpPerTier)} XP · {data.next}</span>
            </>
          ) : (
            <span className="gain">Pass complete</span>
          )}
        </div>
        <div className="card stat" style={{ padding: '18px 20px', gap: 8 }}>
          <span className="stat-label">Unclaimed rewards</span>
          <span className="stat-value">{data.unclaimed}</span>
          <button type="button" className="btn btn-primary" disabled={busy || data.unclaimed === 0} onClick={() => void claim()}>
            {data.unclaimed ? `Claim ${data.unclaimed} reward${data.unclaimed === 1 ? '' : 's'}` : 'All claimed'}
          </button>
        </div>
      </section>

      <section className="split">
        <Card className="main" title="Rewards" action={<span className="small muted">Unclaimed rewards expire when the season ends</span>}>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
            {data.rewards.map((r) => {
              const claimable = r.reached && !r.claimed;
              return (
                <li
                  key={r.tier}
                  className="stack-sm"
                  style={{
                    padding: 12, borderRadius: 12, gap: 6, minHeight: 112,
                    background: claimable ? 'var(--gold-wash)' : r.claimed ? '#1b2a22' : 'var(--raised)',
                    border: `1.5px solid ${claimable ? 'var(--gold-edge)' : r.claimed ? '#2f5a42' : 'transparent'}`,
                    opacity: r.reached ? 1 : 0.6,
                  }}
                >
                  <span className="mono small muted">TIER {r.tier}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: KIND_TONE[r.reward.kind] }}>{r.label}</span>
                  <span style={{ marginTop: 'auto' }}>
                    {r.claimed ? (
                      <span className="small gain">Claimed</span>
                    ) : claimable ? (
                      <button type="button" className="btn btn-secondary" style={{ padding: '4px 10px' }} disabled={busy} onClick={() => void claim(r.tier)}>Claim</button>
                    ) : (
                      <span className="small muted">{num(r.tier * data.xpPerTier)} XP</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </Card>

        <div className="side stack" style={{ gap: 24 }}>
          <Card title="Titles">
            {titles.length === 0 && <span className="muted">Reach tier 10 to unlock your first title.</span>}
            {titles.map((t) => (
              <div key={t.name} className="row-between">
                <span>{t.name}</span>
                {data.title === t.name ? (
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void equip(null)}>Unequip</button>
                ) : (
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void equip(t.name)}>Equip</button>
                )}
              </div>
            ))}
            <span className="small muted">Your equipped title shows under your company name.</span>
          </Card>
          <Card title="Truck liveries">
            {liveries.length === 0 ? <span className="muted">Every fifth tier unlocks a livery.</span> : liveries.map((l) => <span key={l.name}>{l.name}</span>)}
            <span className="small muted">Cosmetic only. Liveries will show on your delivery trucks once freight is in the game.</span>
          </Card>
        </div>
      </section>
    </>
  );
}
