import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TopBar } from '../components/AppShell';
import { Card, ProgressBar, StatTile } from '../components/ui';
import { LAB_RP_PER_DAY, nodeState, RESEARCH_FAMILIES, RESEARCH_THRESHOLDS } from '../data/research';
import { num } from '../lib/format';
import { useGame } from '../state/game';

const GRID = { display: 'grid', gridTemplateColumns: '140px repeat(5, minmax(96px, 1fr))', gap: 10, minWidth: 660, alignItems: 'center' } as const;
const THRESHOLD_LABEL = ['50', '250', '1.5k', '6k', '20k'];

export function Research() {
  const { notify } = useGame();
  const [sel, setSel] = useState({ f: 1, q: 3 });
  const [focus, setFocus] = useState(1);

  const fam = RESEARCH_FAMILIES[sel.f];
  const qi = sel.q - 1;
  const node = nodeState(fam.points, qi);
  const thr = RESEARCH_THRESHOLDS[qi];
  const isFocus = focus === sel.f;
  const left = thr - fam.points;
  const eta = node.state === 'done'
    ? 'Already researched.'
    : isFocus
      ? `About ${Math.ceil(left / LAB_RP_PER_DAY)} days at your lab’s ${LAB_RP_PER_DAY} RP/day.`
      : 'Not your lab’s focus. Switch focus to start earning points here.';

  return (
    <>
      <TopBar title="Research" subtitle="Eight families · each tier raises your quality cap and unlocks recipes" />
      <section className="grid-auto">
        <StatTile label="R&D Lab · Lv 2" value={<>{LAB_RP_PER_DAY} <span className="muted" style={{ fontSize: 15 }}>RP / day</span></>} deltaTone="muted" delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Focus: <strong style={{ color: 'var(--text)' }}>{RESEARCH_FAMILIES[focus].name}</strong></span>} />
        <StatTile label="Research points on hand" value="320" deltaTone="muted" delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Tradeable on the exchange · <Link to="/app/market">buy or sell</Link></span>} />
        <StatTile label="Innovation rank" value="#1,204" deltaTone="muted" delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>+500 bonus for being first to a quality tier</span>} />
      </section>

      <section className="split">
        <Card style={{ flex: '3 1 620px', gap: 6 }}>
          <div className="scroll-x">
            <div className="stack-sm" style={{ gap: 6 }}>
              <div style={{ ...GRID, fontSize: 12, color: 'var(--muted)', paddingBottom: 6 }}>
                <span>Family</span>
                {THRESHOLD_LABEL.map((t, i) => <span key={t} className="mono" style={{ textAlign: 'center' }}>Q{i + 1} · {t}</span>)}
              </div>
              {RESEARCH_FAMILIES.map((f, fi) => (
                <div key={f.id} style={GRID}>
                  <div className="stack-sm" style={{ gap: 2 }}>
                    <span className="row" style={{ gap: 8, fontWeight: 600 }}><span className="swatch" style={{ background: f.color }} />{f.name}</span>
                    <span className="mono muted" style={{ fontSize: 11 }}>{num(f.points)} RP</span>
                  </div>
                  {f.unlocks.map((title, i) => {
                    const n = nodeState(f.points, i);
                    const selected = sel.f === fi && sel.q === i + 1;
                    return (
                      <button
                        key={title}
                        type="button"
                        aria-pressed={selected}
                        aria-label={`${f.name} Q${i + 1}: ${title}, ${n.state === 'done' ? 'researched' : n.state === 'current' ? 'in progress' : 'locked'}`}
                        onClick={() => setSel({ f: fi, q: i + 1 })}
                        style={{
                          minHeight: 56, padding: '8px 10px', borderRadius: 12, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4,
                          border: `1.5px solid ${selected ? 'var(--text)' : n.state === 'done' ? '#2f5a42' : n.state === 'current' ? 'var(--gold)' : 'var(--line)'}`,
                          background: n.state === 'done' ? '#1b2a22' : n.state === 'current' ? 'var(--raised)' : '#11151b',
                          color: n.state === 'locked' ? 'var(--muted)' : 'var(--text)',
                        }}
                      >
                        <span style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.25 }}>{title}</span>
                        <span style={{ width: '100%' }}><ProgressBar value={n.progress} size="thin" color={f.color} /></span>
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
            <span className="overline" style={{ color: fam.color, fontWeight: 700 }}>{fam.name} · Q{sel.q}</span>
            <h2 className="disp" style={{ fontSize: 24, fontWeight: 600 }}>{fam.unlocks[qi]}</h2>
            <span style={{ fontSize: 13, fontWeight: 600, color: node.state === 'done' ? 'var(--gain)' : node.state === 'current' ? 'var(--gold)' : 'var(--muted)' }}>
              {node.state === 'done' ? 'Researched' : node.state === 'current' ? 'In progress' : `Locked · finish Q${sel.q - 1} first`}
            </span>
          </div>
          <div className="stack-sm">
            <div className="row-between" style={{ fontSize: 13 }}><span className="muted">Progress</span><span className="mono">{num(Math.min(fam.points, thr))} / {num(thr)} RP</span></div>
            <ProgressBar value={Math.min(1, fam.points / thr)} size="thick" color={fam.color} label="Research progress" />
            <span className="muted" style={{ fontSize: 13 }}>{eta}</span>
          </div>
          <div className="stack-sm">
            <span className="overline">Unlocks</span>
            <span>{fam.unlocks[qi]} recipes and products, plus a +1 research bonus to {fam.name} output quality.</span>
            <span className="muted" style={{ fontSize: 13 }}>Output can reach Q{sel.q} when inputs allow (never above the lowest input + 1).</span>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={isFocus}
            onClick={() => { setFocus(sel.f); notify('Lab focus changed', `Your R&D Lab now researches ${fam.name}.`, 'info'); }}
          >
            {isFocus ? `Lab already focused on ${fam.name}` : `Focus lab on ${fam.name}`}
          </button>
          <Link to="/app/market" className="btn btn-secondary">Buy research points</Link>
        </Card>
      </section>
    </>
  );
}
