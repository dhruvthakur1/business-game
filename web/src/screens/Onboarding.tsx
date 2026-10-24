import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { Logo } from '../components/Icon';
import { Toasts } from '../components/AppShell';
import { Card, ProgressBar } from '../components/ui';
import { buildingTypeById } from '../data/catalog';
import { netPerDay, paybackDays } from '../lib/economy';
import { dec, duration, num } from '../lib/format';
import { useGame } from '../state/game';
import { STARTING_CAPITAL } from '../../../shared/catalog';

const farm = buildingTypeById('farm');
const SEEDS = { qty: 60, price: 1.2 };
const FERT = { qty: 20, price: 4 };
const INPUT_COST = SEEDS.qty * SEEDS.price + FERT.qty * FERT.price;
const FARM_NET = netPerDay({ output: { qty: 100, price: 4.5 }, inputs: [SEEDS, FERT], opCost: farm.opCost, upkeepPerDay: farm.upkeepPerDay });

const REGIONS = [
  { id: 'north', name: 'North', tag: 'Recommended', bonus: '+10% agriculture yield', note: 'Best for a food start' },
  { id: 'east', name: 'East', tag: '', bonus: 'Mining bonus', note: 'Coal, iron, quarries' },
  { id: 'south', name: 'South', tag: '', bonus: 'Ports & logistics', note: 'Cheaper freight hubs' },
  { id: 'west', name: 'West', tag: '', bonus: 'Tech & finance', note: 'Wage index 1.3' },
];

const STEPS = [
  { title: 'Name your company', lead: `Every empire starts with a name. You get ${num(STARTING_CAPITAL)} CR of welcome capital.`, tip: 'Pick something you will be happy to see on a leaderboard.' },
  { title: 'Choose a home region', lead: 'Your first 12 plots are here. Shipping inside a region takes 1 hour; between regions, 4 hours plus freight.', tip: 'Regional bonuses are not simulated yet; North is the classic food start.' },
  { title: 'Buy your first building', lead: 'Farms are cheap, fast and supply everyone else. Buildings run one 4-hour job at a time.', tip: 'Long-term, the mill and bakery earn more. The farm feeds them.' },
  { title: 'Stock up on inputs', lead: 'Production takes its inputs from your warehouse when a job starts. Buy one cycle from the NPC vendor.', tip: 'Later, other players may sell seeds cheaper on the exchange.' },
  { title: 'Start your first harvest', lead: 'Press start and the clock runs on the server while you are away.', tip: 'Collect from Headquarters when the job turns Ready.' },
];

export function Onboarding() {
  const navigate = useNavigate();
  const game = useGame();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [region, setRegion] = useState('north');
  const [farmId, setFarmId] = useState<string | null>(null);
  const [inputs, setInputs] = useState(false);
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);

  const cash = created ? game.cash : STARTING_CAPITAL;
  const job = farmId ? game.buildings.find((b) => b.id === farmId) : undefined;

  const createCompany = async () => {
    setBusy(true);
    try {
      await game.createCompany(name.trim(), region);
      setCreated(true);
      setStep(2);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setNameError(err.code === 'offline' ? 'The game server is not running.' : err.message);
      setStep(0);
    } finally {
      setBusy(false);
    }
  };

  const ready = [name.trim().length >= 3, true, !!farmId, inputs, started];
  const checks: [string, boolean][] = [
    ['Claim welcome capital', true],
    ['Name your company', created],
    ['Choose a region', created],
    ['Buy a Grain Farm', !!farmId],
    ['Buy seeds & fertilizer', inputs],
    ['Start the first cycle', started],
  ];
  const done = checks.filter(([, ok]) => ok).length;
  const s = STEPS[step];

  const next = () => {
    if (step === 1 && !created) return void createCompany();
    setStep((x) => x + 1);
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header className="row-between" style={{ padding: '20px 32px', borderBottom: '1px solid var(--line-soft)' }}>
        <Link to="/" className="brand"><Logo /><span className="brand-name">Mercantile</span></Link>
        <div className="row" style={{ gap: 20 }}>
          <div className="pill-stat"><span className="small muted">Cash</span><span className="mono goldtx" style={{ fontWeight: 600 }}>{num(cash)} CR</span></div>
          <Link to="/app" className="muted">Skip tutorial</Link>
        </div>
      </header>

      <div className="split" style={{ maxWidth: 1240, width: '100%', margin: '0 auto', padding: '40px 32px 56px', gap: 32 }}>
        <main className="stack" style={{ flex: '3 1 560px', minWidth: 0, gap: 24 }}>
          <div className="stack-sm" style={{ gap: 10 }}>
            <span className="mono goldtx" style={{ fontSize: 13 }}>STEP {step + 1} OF {STEPS.length}</span>
            <h1 className="disp" style={{ fontSize: 40, fontWeight: 700, letterSpacing: -1, lineHeight: 1.1 }}>{s.title}</h1>
            <p className="muted" style={{ fontSize: 17, maxWidth: 640 }}>{s.lead}</p>
          </div>

          {step === 0 && (
            <Card>
              <label className="field" style={{ fontSize: 14 }}>
                Company name
                <input
                  className="input"
                  style={{ height: 52, fontSize: 18 }}
                  value={name}
                  maxLength={28}
                  placeholder="e.g. Northwind Holdings"
                  autoFocus
                  aria-invalid={!!nameError}
                  disabled={created}
                  onChange={(e) => { setName(e.target.value); setNameError(null); }}
                />
              </label>
              {nameError ? <span className="loss" style={{ fontSize: 13 }}>{nameError}</span> : <span className="muted" style={{ fontSize: 13 }}>Shown on the exchange, in leagues and on your storefront. Must be unique.</span>}
            </Card>
          )}

          {step === 1 && (
            <div role="radiogroup" aria-label="Home region" className="grid-auto">
              {REGIONS.map((r) => (
                <button key={r.id} type="button" role="radio" aria-checked={r.id === region} disabled={created} className="option" style={{ minHeight: 120, padding: 18, gap: 6, background: r.id === region ? undefined : 'var(--panel)' }} onClick={() => setRegion(r.id)}>
                  <span className="row-between"><span className="disp" style={{ fontSize: 20, fontWeight: 600 }}>{r.name}</span><span className="goldtx" style={{ fontSize: 11, fontWeight: 700 }}>{r.tag}</span></span>
                  <span style={{ color: 'var(--text-soft)' }}>{r.bonus}</span>
                  <span className="small muted">{r.note}</span>
                </button>
              ))}
            </div>
          )}

          {step === 2 && (
            <div className="split" style={{ gap: 16 }}>
              <Card className="flush" style={{ flex: '1 1 300px', border: '1.5px solid var(--gold)' }}>
                <div className="art-stage" style={{ paddingTop: 8 }}><img src={farm.art} alt="Grain Farm" width={240} height={216} /></div>
                <div className="stack-sm" style={{ padding: 18 }}>
                  <div className="row-between"><strong className="disp" style={{ fontSize: 20, fontWeight: 600 }}>Grain Farm</strong><span className="goldtx" style={{ fontSize: 11, fontWeight: 700 }}>RECOMMENDED</span></div>
                  <span className="muted">60 seeds + 20 fertilizer → 100 wheat every 4h · about +{num(FARM_NET)} CR/day · pays back in about {Math.round(paybackDays(farm.buildCost, FARM_NET))} days</span>
                  <button
                    type="button"
                    className="btn btn-primary btn-lg"
                    disabled={!!farmId || busy}
                    onClick={async () => { setBusy(true); setFarmId(await game.buyBuilding('farm')); setBusy(false); }}
                  >
                    {farmId ? 'Bought · placed on plot 1' : `Buy for ${num(farm.buildCost)} CR`}
                  </button>
                </div>
              </Card>
              <div className="stack" style={{ flex: '1 1 220px', gap: 12 }}>
                {(['mill', 'bakery'] as const).map((id) => {
                  const t = buildingTypeById(id);
                  return (
                    <div key={id} className="card" style={{ flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12, opacity: 0.7 }}>
                      <img src={t.art} alt="" width={80} height={72} />
                      <div className="stack-sm" style={{ gap: 4 }}>
                        <strong>{t.name} · {num(t.buildCost)}</strong>
                        <span className="small muted">{id === 'mill' ? 'Build next, once you have wheat' : 'Turns flour into bread'}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {step === 3 && (
            <Card title="NPC farm supply" action={<span className="muted" style={{ fontSize: 13 }}>Fixed prices · always in stock</span>}>
              <div className="stack-sm mono" style={{ gap: 10 }}>
                <div className="inset row-between"><span style={{ fontFamily: 'var(--font-ui)' }}>Seeds · {SEEDS.qty} × {dec(SEEDS.price)}</span><span>{dec(SEEDS.qty * SEEDS.price)}</span></div>
                <div className="inset row-between"><span style={{ fontFamily: 'var(--font-ui)' }}>Fertilizer · {FERT.qty} × {dec(FERT.price)}</span><span>{dec(FERT.qty * FERT.price)}</span></div>
                <div className="row-between" style={{ padding: '4px 14px', fontSize: 16, fontWeight: 600 }}><span style={{ fontFamily: 'var(--font-ui)' }}>Total for one cycle</span><span className="goldtx">{dec(INPUT_COST)} CR</span></div>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-lg"
                disabled={inputs || busy}
                onClick={async () => {
                  setBusy(true);
                  const ok = (await game.npcBuy('seeds', SEEDS.qty)) && (await game.npcBuy('fertilizer', FERT.qty));
                  setInputs(ok);
                  setBusy(false);
                }}
              >
                {inputs ? 'In your warehouse' : `Buy for ${dec(INPUT_COST)} CR`}
              </button>
            </Card>
          )}

          {step === 4 && (
            <Card style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 24 }}>
              <img src={farm.art} alt="Your Grain Farm" width={220} height={198} />
              <div className="stack" style={{ flex: '1 1 280px', gap: 14 }}>
                <div className="row" style={{ fontSize: 14 }}>
                  <span className="chip" style={{ background: 'var(--t0-bg)', color: 'var(--t0-fg)', padding: '8px 12px' }}>60 seeds + 20 fertilizer</span>
                  <span className="muted">→</span>
                  <span className="chip" style={{ background: 'var(--t1-bg)', color: 'var(--t1-fg)', padding: '8px 12px' }}>100 wheat</span>
                </div>
                <ProgressBar value={job?.progress ?? 0} size="thick" label="First harvest progress" />
                <span className="mono small muted">
                  {job?.status === 'ready' ? 'Harvest is ready!' : started && job ? `Harvest lands in ${duration(job.minutesLeft)} of game time` : 'Takes 4 game hours · inputs reserved at start'}
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  disabled={started || busy || !farmId}
                  onClick={async () => { setBusy(true); setStarted(await game.startJob(farmId!)); setBusy(false); }}
                >
                  {started ? 'Growing…' : 'Start production'}
                </button>
              </div>
            </Card>
          )}

          {started && (
            <div className="card" style={{ background: 'var(--gain-wash)', borderColor: '#1f4a33', gap: 10 }} role="status">
              <strong className="gain">You're in business, {name.trim()}.</strong>
              <span style={{ color: 'var(--text-soft)' }}>When the harvest lands, sell wheat to NPC buyers or other players on the exchange. Next up: build a mill.</span>
              <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('/app')}>Go to Headquarters</button>
            </div>
          )}

          <div className="row-between">
            <button type="button" className="btn btn-secondary" disabled={step === 0 || (created && step <= 2)} onClick={() => setStep((x) => Math.max(0, x - 1))}>Back</button>
            {step < STEPS.length - 1 && (
              <button type="button" className="btn btn-primary" disabled={!ready[step] || busy} onClick={next}>
                {step === 1 && !created ? (busy ? 'Founding…' : 'Found company') : 'Continue'}
              </button>
            )}
          </div>
        </main>

        <aside aria-label="First-day checklist" className="card" style={{ flex: '1 1 300px', gap: 14 }}>
          <div className="row-between" style={{ alignItems: 'baseline' }}><strong className="disp" style={{ fontSize: 18 }}>First day</strong><span className="mono muted">{done} / {checks.length}</span></div>
          <ProgressBar value={done / checks.length} label="First-day checklist progress" />
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack-sm">
            {checks.map(([label, ok]) => (
              <li key={label} className="row" style={{ gap: 10, minHeight: 36, color: ok ? 'var(--text)' : 'var(--muted)', flexWrap: 'nowrap' }}>
                <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, background: ok ? 'var(--gain)' : 'transparent', color: 'var(--ground)', border: `1.5px solid ${ok ? 'var(--gain)' : 'var(--line-strong)'}` }}>{ok ? '✓' : ''}</span>
                {label}
                <span className="sr-only">{ok ? 'done' : 'to do'}</span>
              </li>
            ))}
          </ul>
          <div className="inset stack-sm" style={{ gap: 4 }}>
            <span className="overline" style={{ color: 'var(--info)', fontWeight: 700 }}>Tip</span>
            <span style={{ fontSize: 13, color: 'var(--text-soft)' }}>{s.tip}</span>
          </div>
        </aside>
      </div>
      <Toasts />
    </div>
  );
}
