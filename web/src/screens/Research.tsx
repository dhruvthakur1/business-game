import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { ResearchResponse } from '../api/types';
import { TopBar } from '../components/AppShell';
import { Card, ProgressBar, StatTile, Stepper } from '../components/ui';
import { num } from '../lib/format';
import { useGame } from '../state/game';
import { BUILDING_FAMILY, type FamilyId } from '../../../shared/research';
import { buildingTypeById } from '../data/catalog';

const GRID = { display: 'grid', gridTemplateColumns: '140px repeat(5, minmax(96px, 1fr))', gap: 10, minWidth: 660, alignItems: 'center' } as const;
const THRESHOLD_LABEL = ['50', '250', '1.5k', '6k', '20k'];
const REFRESH_MS = 5000;

const FAMILY_COLOR: Record<FamilyId, string> = {
  agri: 'var(--t1)', food: 'var(--t4)', textiles: 'var(--master-fg)', metals: '#e07b39',
  electronics: 'var(--t2)', auto: 'var(--t6)', luxury: 'var(--gold)', energy: 'var(--t5)',
};

type NodeState = 'done' | 'current' | 'locked';

function nodeState(thresholds: number[], points: number, tierIndex: number): { state: NodeState; progress: number } {
  const prev = tierIndex === 0 ? 0 : thresholds[tierIndex - 1];
  const thr = thresholds[tierIndex];
  if (points >= thr) return { state: 'done', progress: 1 };
  if (points >= prev) return { state: 'current', progress: (points - prev) / (thr - prev) };
  return { state: 'locked', progress: 0 };
}

/** Building names whose output quality a family's research improves. */
const familyBuildings = (f: FamilyId) =>
  Object.entries(BUILDING_FAMILY).filter(([, fam]) => fam === f).map(([id]) => buildingTypeById(id).name);

export function Research() {
  const { act, notify } = useGame();
  const [data, setData] = useState<ResearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<{ f: number; q: number } | null>(null);
  const [apply, setApply] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<ResearchResponse>('/research'));
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

  const run = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    const res = await act(fn);
    await load();
    setBusy(false);
    return res;
  };

  if (!data) {
    return (
      <>
        <TopBar title="Research" subtitle="Eight families · each tier raises your quality cap" />
        <p className={error ? 'loss' : 'muted'}>{error ?? 'Loading research…'}</p>
      </>
    );
  }

  const { thresholds, families } = data;
  // Default selection: the focus family's next tier, else the first family's.
  const focusIdx = families.findIndex((f) => f.id === data.focus);
  const current = sel ?? { f: Math.max(0, focusIdx), q: Math.min(5, families[Math.max(0, focusIdx)].tier + 1) };
  const fam = families[current.f];
  const qi = current.q - 1;
  const node = nodeState(thresholds, fam.points, qi);
  const thr = thresholds[qi];
  const isFocus = data.focus === fam.id;
  const left = Math.max(0, thr - fam.points);
  const first = fam.firsts.find((x) => x.tier === current.q);
  const eta = node.state === 'done'
    ? 'Already researched.'
    : data.labs.length === 0
      ? 'You have no R&D Lab yet. Build one (Lv 3) or buy research points on the exchange.'
      : isFocus
        ? data.rpPerDay > 0 ? `About ${Math.ceil(left / data.rpPerDay)} days at your labs’ ${num(data.rpPerDay)} RP/day.` : 'Your labs are idle.'
        : 'Not your labs’ focus. Switch focus to start earning points here.';
  const applyQty = Math.min(apply || Math.min(left, data.rpOnHand), data.rpOnHand);
  const stepQty = Math.max(10, Math.round(data.rpOnHand / 10 / 10) * 10);
  const buildingsHelped = familyBuildings(fam.id);

  const changeFocus = async (family: FamilyId | null) => {
    const res = await run(() => api('/research/focus', { body: { family } }));
    if (res) notify('Lab focus changed', family ? `Your R&D Labs now research ${families.find((f) => f.id === family)!.name}.` : 'Lab output now goes to the warehouse as tradeable research points.', 'info');
  };

  const applyPoints = async () => {
    const res = await run(() => api<{ tiersReached: number[]; firsts: number[] }>('/research/apply', { body: { family: fam.id, points: applyQty } }));
    if (!res) return;
    setApply(0);
    const reached = res.tiersReached.length ? ` Reached ${res.tiersReached.map((t) => `Q${t}`).join(', ')}.` : '';
    const firsts = res.firsts.length ? ` First on the server: +${num(res.firsts.length * data.innovation.firstBonusXp)} XP!` : '';
    notify('Research applied', `${num(applyQty)} RP added to ${fam.name}.${reached}${firsts}`);
  };

  return (
    <>
      <TopBar title="Research" subtitle="Eight families · each tier raises your quality cap" />
      <section className="grid-auto">
        <StatTile
          label={data.labs.length ? `R&D Lab${data.labs.length > 1 ? `s × ${data.labs.length}` : ` · Lv ${data.labs[0].level}`}` : 'R&D Lab'}
          value={<>{num(data.rpPerDay)} <span className="muted" style={{ fontSize: 15 }}>RP / day</span></>}
          deltaTone="muted"
          delta={
            <span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>
              {data.labs.length === 0 ? <>None yet · <Link to="/app">build one</Link></> : <>Focus: <strong style={{ color: 'var(--text)' }}>{families.find((f) => f.id === data.focus)?.name ?? 'none (to warehouse)'}</strong></>}
            </span>
          }
        />
        <StatTile
          label="Research points on hand"
          value={num(data.rpOnHand)}
          deltaTone="muted"
          delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Tradeable on the exchange · <Link to="/app/market?product=research_points">buy or sell</Link></span>}
        />
        <StatTile
          label="Innovation rank"
          value={`#${num(data.innovation.rank)}`}
          deltaTone="muted"
          delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>of {num(data.innovation.of)} · {num(data.innovation.totalPoints)} RP total · +{num(data.innovation.firstBonusXp)} XP for being first to a tier</span>}
        />
      </section>

      <section className="split">
        <Card style={{ flex: '3 1 620px', gap: 6 }}>
          <div className="scroll-x">
            <div className="stack-sm" style={{ gap: 6 }}>
              <div style={{ ...GRID, fontSize: 12, color: 'var(--muted)', paddingBottom: 6 }}>
                <span>Family</span>
                {THRESHOLD_LABEL.map((t, i) => <span key={t} className="mono" style={{ textAlign: 'center' }}>Q{i + 1} · {t}</span>)}
              </div>
              {families.map((f, fi) => (
                <div key={f.id} style={GRID}>
                  <div className="stack-sm" style={{ gap: 2 }}>
                    <span className="row" style={{ gap: 8, fontWeight: 600 }}>
                      <span className="swatch" style={{ background: FAMILY_COLOR[f.id] }} />{f.name}
                      {data.focus === f.id && <span className="chip" style={{ fontSize: 10, padding: '1px 6px', background: 'var(--gold-wash)', color: 'var(--gold)' }}>Focus</span>}
                    </span>
                    <span className="mono muted" style={{ fontSize: 11 }}>{num(f.points)} RP</span>
                  </div>
                  {f.planned.map((title, i) => {
                    const n = nodeState(thresholds, f.points, i);
                    const selected = current.f === fi && current.q === i + 1;
                    return (
                      <button
                        key={title}
                        type="button"
                        aria-pressed={selected}
                        aria-label={`${f.name} Q${i + 1}: ${title}, ${n.state === 'done' ? 'researched' : n.state === 'current' ? 'in progress' : 'locked'}`}
                        onClick={() => { setSel({ f: fi, q: i + 1 }); setApply(0); }}
                        style={{
                          minHeight: 56, padding: '8px 10px', borderRadius: 12, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4,
                          border: `1.5px solid ${selected ? 'var(--text)' : n.state === 'done' ? '#2f5a42' : n.state === 'current' ? 'var(--gold)' : 'var(--line)'}`,
                          background: n.state === 'done' ? '#1b2a22' : n.state === 'current' ? 'var(--raised)' : '#11151b',
                          color: n.state === 'locked' ? 'var(--muted)' : 'var(--text)',
                        }}
                      >
                        <span style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.25 }}>{title}</span>
                        <span style={{ width: '100%' }}><ProgressBar value={n.progress} size="thin" color={FAMILY_COLOR[f.id]} /></span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="row small muted" style={{ gap: 16, paddingTop: 10 }}>
            <span className="row" style={{ gap: 6 }}><span style={{ width: 12, height: 12, borderRadius: 4, background: '#1b2a22', border: '1.5px solid #2f5a42' }} />Researched</span>
            <span className="row" style={{ gap: 6 }}><span style={{ width: 12, height: 12, borderRadius: 4, background: 'var(--raised)', border: '1.5px solid var(--gold)' }} />In progress</span>
            <span className="row" style={{ gap: 6 }}><span style={{ width: 12, height: 12, borderRadius: 4, background: '#11151b', border: '1.5px solid var(--line)' }} />Locked</span>
          </div>
        </Card>

        <Card style={{ flex: '1 1 320px' }}>
          <div className="stack-sm" style={{ gap: 6 }}>
            <span className="overline" style={{ color: FAMILY_COLOR[fam.id], fontWeight: 700 }}>{fam.name} · Q{current.q}</span>
            <h2 className="disp" style={{ fontSize: 24, fontWeight: 600 }}>{fam.planned[qi]}</h2>
            <span style={{ fontSize: 13, fontWeight: 600, color: node.state === 'done' ? 'var(--gain)' : node.state === 'current' ? 'var(--gold)' : 'var(--muted)' }}>
              {node.state === 'done' ? 'Researched' : node.state === 'current' ? 'In progress' : `Locked · finish Q${current.q - 1} first`}
            </span>
          </div>
          <div className="stack-sm">
            <div className="row-between" style={{ fontSize: 13 }}><span className="muted">Progress</span><span className="mono">{num(Math.min(fam.points, thr))} / {num(thr)} RP</span></div>
            <ProgressBar value={Math.min(1, fam.points / thr)} size="thick" color={FAMILY_COLOR[fam.id]} label="Research progress" />
            <span className="muted" style={{ fontSize: 13 }}>{eta}</span>
          </div>
          <div className="stack-sm">
            <span className="overline">What it does</span>
            <span>
              {buildingsHelped.length
                ? <>Output from your {buildingsHelped.join(', ')} can step one quality above its inputs, up to Q{current.q}.</>
                : <>No buildings in this family yet.</>}
            </span>
            <span className="muted" style={{ fontSize: 13 }}>Never above the lowest input + 1. The {fam.planned[qi].toLowerCase()} recipes are coming in a later update.</span>
            <span className="small" style={{ color: first ? (first.mine ? 'var(--gold)' : 'var(--muted)') : 'var(--muted)' }}>
              {first ? (first.mine ? 'You were first on the server to reach this tier.' : `First reached by ${first.companyName}.`) : `Nobody has reached this tier yet: first gets +${num(data.innovation.firstBonusXp)} XP.`}
            </span>
          </div>
          {data.labs.length > 0 && (
            <button type="button" className="btn btn-primary btn-lg" disabled={isFocus || busy} onClick={() => void changeFocus(fam.id)}>
              {isFocus ? `Labs focused on ${fam.name}` : `Focus labs on ${fam.name}`}
            </button>
          )}
          {isFocus && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void changeFocus(null)}>
              Send lab output to the warehouse instead
            </button>
          )}
          {node.state !== 'done' && data.rpOnHand > 0 && (
            <div className="inset stack-sm">
              <span className="small muted">Apply research points from your warehouse</span>
              <Stepper
                value={`${num(applyQty)} RP`}
                decLabel="Fewer points"
                incLabel="More points"
                onDec={() => setApply(Math.max(1, applyQty - stepQty))}
                onInc={() => setApply(Math.min(data.rpOnHand, applyQty + stepQty))}
              />
              <button type="button" className="btn btn-secondary" disabled={busy || applyQty <= 0} onClick={() => void applyPoints()}>
                Apply {num(applyQty)} RP to {fam.name}
              </button>
            </div>
          )}
          <Link to="/app/market?product=research_points" className="btn btn-secondary">Buy research points</Link>
          {data.recent.length > 0 && (
            <div className="stack-sm">
              <span className="overline">Recent</span>
              {data.recent.slice(0, 4).map((r, i) => (
                <span key={i} className="small muted">
                  +{num(r.points)} RP {families.find((f) => f.id === r.family)?.name} · {r.source === 'lab' ? 'from labs' : 'applied'}
                </span>
              ))}
            </div>
          )}
        </Card>
      </section>
    </>
  );
}
