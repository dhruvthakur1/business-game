import { useState } from 'react';
import { TopBar } from '../components/AppShell';
import { Callout, Card, ProgressBar, Stepper } from '../components/ui';
import { designerArt, LOGOS, TAKEN_BRANDS, TEMPLATES, VARIANT_TIERS, type ProductTemplate, type VariantTier } from '../data/designer';
import { valueCheck } from '../lib/economy';
import { num } from '../lib/format';
import { useGame } from '../state/game';

type Choices = Record<string, number>;

const STEPS = ['Template', 'Materials', 'Variant tier', 'Brand', 'Value check'];

function LogoGlyph({ d, size = 24 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Designer() {
  const { notify } = useGame();
  const [tplId, setTplId] = useState<ProductTemplate['id']>('watch');
  const [choices, setChoices] = useState<Record<string, Choices>>({ watch: {}, dress: {}, sneaker: {} });
  const [tier, setTier] = useState<VariantTier>('premium');
  const [priceOverride, setPriceOverride] = useState<number | null>(null);
  const [brand, setBrand] = useState('Northwind Atelier');
  const [logo, setLogo] = useState(0);
  const [saved, setSaved] = useState(false);

  const tpl = TEMPLATES.find((t) => t.id === tplId)!;
  const ch = choices[tplId];
  const variant = VARIANT_TIERS[tier];
  const picked = tpl.slots.map((s) => s.options[ch[s.key] ?? 0]);
  const inputs = picked.reduce((sum, o) => sum + o.cost, 0) * variant.inputMult;
  const suggested = Math.round((inputs * 1.45 + tpl.opCost) / 5) * 5;
  const price = priceOverride ?? suggested;
  const check = valueCheck(inputs, tpl.opCost, price, tpl.maxValueAdd);
  const step = Math.max(5, Math.round((check.max * 0.05) / 5) * 5);

  const name = brand.trim();
  const taken = TAKEN_BRANDS.includes(name.toLowerCase());
  const nameOk = name.length >= 3 && !taken;
  const canSave = check.pass && nameOk;
  const art = designerArt(tplId, tier, tplId === 'watch' && (ch.case ?? 0) === 2);

  const reset = () => { setPriceOverride(null); setSaved(false); };
  const pick = (slot: string, i: number) => { setChoices({ ...choices, [tplId]: { ...ch, [slot]: i } }); reset(); };

  const stage =
    tier === 'luxury' ? 'radial-gradient(circle at 50% 45%, #4a3a16, var(--sunken) 72%)'
      : tier === 'premium' ? 'radial-gradient(circle at 50% 45%, #22314a, var(--sunken) 72%)'
        : 'var(--sunken)';

  return (
    <>
      <TopBar title="Product designer" subtitle="Pick a template, choose materials, put your name on it" />
      <ol aria-label="Steps" className="row" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 8 }}>
        {STEPS.map((s, i) => (
          <li key={s} className="chip pill" style={{ background: '#151a22', border: '1px solid var(--line)', fontSize: 13, fontWeight: 500, padding: '8px 12px' }}>
            <span className="mono goldtx">{i + 1}</span> {s}
          </li>
        ))}
      </ol>

      <section className="split">
        <div className="main stack" style={{ gap: 24 }}>
          <Card title="1 · Template">
            <div role="radiogroup" aria-label="Template" className="grid-auto-sm">
              {TEMPLATES.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={t.id === tplId} className="option" style={{ minHeight: 72 }} onClick={() => { setTplId(t.id); reset(); }}>
                  <strong style={{ fontSize: 15 }}>{t.label}</strong>
                  <span className="small muted">{t.building}</span>
                </button>
              ))}
            </div>
          </Card>

          <Card title="2 · Materials" action={<span className="muted" style={{ fontSize: 13 }}>Only options the template allows · cost per unit at reference price</span>}>
            {tpl.slots.map((s) => (
              <fieldset key={s.key} style={{ border: 0, margin: 0, padding: 0 }}>
                <legend className="muted" style={{ fontSize: 13, marginBottom: 8 }}>{s.label}</legend>
                <div className="row" style={{ gap: 8 }}>
                  {s.options.map((o, i) => (
                    <button key={o.name} type="button" aria-pressed={(ch[s.key] ?? 0) === i} className="option inline" onClick={() => pick(s.key, i)}>
                      {o.name}<span className="mono small muted">{o.cost} CR</span>
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
          </Card>

          <Card title="3 · Variant tier">
            <div role="radiogroup" aria-label="Variant tier" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              {(Object.keys(VARIANT_TIERS) as VariantTier[]).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={k === tier} className="option" style={{ minHeight: 72 }} onClick={() => { setTier(k); reset(); }}>
                  <strong style={{ fontSize: 15 }}>{VARIANT_TIERS[k].label}</strong>
                  <span className="mono small muted">×{VARIANT_TIERS[k].inputMult} inputs · ×{VARIANT_TIERS[k].bandMult} price band</span>
                </button>
              ))}
            </div>
          </Card>

          <Card title="4 · Brand">
            <div className="row" style={{ alignItems: 'flex-end', gap: 16 }}>
              <label className="field" style={{ flex: '1 1 260px' }}>
                Brand name
                <input className="input" value={brand} maxLength={24} aria-invalid={!nameOk} onChange={(e) => { setBrand(e.target.value); setSaved(false); }} />
              </label>
              <div role="radiogroup" aria-label="Logo" className="row" style={{ gap: 8 }}>
                {LOGOS.map((l, i) => (
                  <button key={l.name} type="button" role="radio" aria-checked={i === logo} aria-label={`${l.name} logo`} className="option" style={{ width: 48, height: 48, padding: 0, alignItems: 'center', justifyContent: 'center', color: 'var(--gold)' }} onClick={() => setLogo(i)}>
                    <LogoGlyph d={l.d} />
                  </button>
                ))}
              </div>
            </div>
            <span className={nameOk ? 'gain' : 'loss'} style={{ fontSize: 13 }}>
              {taken ? 'That name is taken. Brand names are unique across the server.' : name.length < 3 ? 'At least 3 characters.' : 'Available · checked for uniqueness and profanity'}
            </span>
          </Card>
        </div>

        <div className="side stack" style={{ gap: 24 }}>
          <Card className="flush">
            <div className="stack" style={{ background: 'var(--raised)', padding: 24, gap: 14 }}>
              <div className="art-stage" style={{ height: 200, borderRadius: 14, background: stage }}>
                <img src={art} alt={`${VARIANT_TIERS[tier].label} ${tpl.label} preview`} width={190} height={190} style={{ objectFit: 'contain' }} />
              </div>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <span style={{ width: 52, height: 52, borderRadius: 14, background: 'var(--gold-wash)', color: 'var(--gold)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <LogoGlyph d={LOGOS[logo].d} size={28} />
                </span>
                <div className="stack-sm" style={{ gap: 2 }}>
                  <span className="goldtx" style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase' }}>{name || 'Your brand'}</span>
                  <strong className="disp" style={{ fontSize: 22, fontWeight: 600 }}>{variant.label} {tpl.label}</strong>
                </div>
              </div>
              <span className="muted" style={{ fontSize: 13 }}>{picked.map((p) => p.name).join(' · ')}</span>
              <span className="chip mono" style={{ alignSelf: 'flex-start', background: 'var(--info-wash)', color: 'var(--info-soft)' }}>Made at: {tpl.building}</span>
            </div>
            <div className="stack" style={{ padding: 20, gap: 12 }}>
              <h2 className="h-section" style={{ fontSize: 18 }}>5 · Value check</h2>
              <div className="stack-sm mono" style={{ fontSize: 13 }}>
                <div className="row-between"><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Inputs per unit</span><span>{num(inputs)}</span></div>
                <div className="row-between"><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Op cost per unit</span><span>{num(tpl.opCost)}</span></div>
                <div className="row-between"><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Max value (inputs × {tpl.maxValueAdd} + op)</span><span>{num(check.max)}</span></div>
              </div>
              <div className="field">
                Target wholesale price
                <Stepper
                  value={`${num(price)} CR`}
                  invalid={!check.pass}
                  decLabel="Lower price"
                  incLabel="Raise price"
                  onDec={() => { setPriceOverride(Math.max(step, price - step)); setSaved(false); }}
                  onInc={() => { setPriceOverride(price + step); setSaved(false); }}
                />
              </div>
              <ProgressBar value={price / check.max} size="thin" color={check.pass ? 'var(--gain)' : 'var(--loss)'} label="Price against value cap" />
              {check.pass ? (
                <Callout tone="ok" title="Passes value check">Margin ≈ {num(check.marginPerUnit)} CR per unit after the 2% fee</Callout>
              ) : (
                <Callout tone="bad" title="Above the value cap">Lower the price or use richer materials. Max is {num(check.max)} CR.</Callout>
              )}
              <button
                type="button"
                className="btn btn-primary btn-lg"
                disabled={!canSave || saved}
                onClick={() => { setSaved(true); notify('Product saved', `${name} ${variant.label} ${tpl.label} added to ${tpl.building.split(' ·')[0]} recipes.`); }}
              >
                {saved ? 'Saved' : 'Save product'}
              </button>
            </div>
          </Card>

          <Card title="Your brands">
            {[
              { name: 'Northwind Atelier', rep: 64, note: '3 products · 41 unique buyers · +12.8% NPC price ceiling', bad: false },
              { name: 'Fieldline Bakehouse', rep: 41, note: 'No sales for 3 days · losing 1% a day', bad: true },
            ].map((b) => (
              <div key={b.name} className="stack-sm" style={{ gap: 6 }}>
                <div className="row-between"><strong>{b.name}</strong><span className="mono">{b.rep} / 100</span></div>
                <ProgressBar value={b.rep / 100} label={`${b.name} reputation`} />
                <span className={`small ${b.bad ? 'loss' : 'muted'}`}>{b.note}</span>
              </div>
            ))}
            <span className="small muted">Reputation grows with units sold to unique buyers, average quality and on-time contracts. It adds up to +20% to the price NPC shoppers will pay.</span>
          </Card>
        </div>
      </section>
    </>
  );
}
