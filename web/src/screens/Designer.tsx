import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, toCr } from '../api/client';
import type { DesignerResponse } from '../api/types';
import { TopBar } from '../components/AppShell';
import { Callout, Card, ProgressBar, Stepper } from '../components/ui';
import { buildingTypeById } from '../data/catalog';
import { LOGOS } from '../data/logos';
import { dec, num } from '../lib/format';
import { useGame } from '../state/game';
import {
  brandNameProblem, designArt, designEconomics, pickedOptions, reputationPriceMultiplier, TEMPLATES, VARIANT_TIERS,
  type TemplateId, type VariantTier,
} from '../../../shared/designer';

const STEPS = ['Template', 'Materials', 'Variant tier', 'Brand', 'Value check'];
const NEW_BRAND = 'new';

function LogoGlyph({ d, size = 24 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Designer() {
  const { act, notify, company, cash } = useGame();
  const [data, setData] = useState<DesignerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tplId, setTplId] = useState<TemplateId>('loaf');
  const [choices, setChoices] = useState<Record<TemplateId, Record<string, number>>>({ loaf: {}, car: {}, watch: {} });
  const [tier, setTier] = useState<VariantTier>('premium');
  const [priceOverride, setPriceOverride] = useState<number | null>(null);
  const [brandSel, setBrandSel] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [logo, setLogo] = useState(0);
  const [nameCheck, setNameCheck] = useState<{ name: string; problem: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<DesignerResponse>('/designer'));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else throw err;
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Server-side uniqueness check for a new brand name, debounced while typing.
  const trimmed = newName.trim().replace(/\s+/g, ' ');
  const localProblem = trimmed ? brandNameProblem(trimmed) : null;
  useEffect(() => {
    if (!trimmed || localProblem) return;
    const t = window.setTimeout(async () => {
      try {
        const res = await api<{ ok: boolean; problem: string | null }>(`/brands/check?name=${encodeURIComponent(trimmed)}`);
        setNameCheck({ name: trimmed, problem: res.problem });
      } catch {
        setNameCheck(null);
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [trimmed, localProblem]);

  if (!data) {
    return (
      <>
        <TopBar title="Product designer" subtitle="Pick a template, choose materials, put your name on it" />
        <p className={error ? 'loss' : 'muted'}>{error ?? 'Loading the designer…'}</p>
      </>
    );
  }

  const ch = choices[tplId];
  const choice = { templateId: tplId, slots: ch, tier };
  const econ = designEconomics(choice);
  const tpl = econ.template;
  const variant = VARIANT_TIERS[tier];
  const picked = pickedOptions(tpl, ch);
  const price = Math.min(econ.maxPrice, priceOverride ?? econ.suggested);
  const step = Math.max(1, Math.round(econ.maxPrice * 0.02));
  const margin = price * 0.98 - econ.inputs - econ.op;
  const art = designArt(choice);
  const building = buildingTypeById(tpl.buildingTypeId);
  const ownsBuilding = data.buildings.some((b) => b.typeId === tpl.buildingTypeId);

  const brandId = brandSel ?? data.brands[0]?.id ?? NEW_BRAND;
  const brand = data.brands.find((b) => b.id === brandId);
  const creating = brandId === NEW_BRAND;
  const canAddBrand = data.brands.length < data.rules.maxPerCompany;
  const nameProblem = localProblem ?? (nameCheck?.name === trimmed ? nameCheck.problem : null);
  const nameReady = !!trimmed && !localProblem && nameCheck?.name === trimmed && !nameCheck.problem;
  const repTooLow = brand ? brand.reputation < variant.minReputation : variant.minReputation > data.rules.startingReputation;
  const brandFull = brand ? brand.designs >= data.rules.maxDesignsPerBrand : false;
  const displayBrand = creating ? trimmed || 'Your brand' : brand!.name;

  const reset = () => setPriceOverride(null);
  const pick = (slot: string, i: number) => { setChoices({ ...choices, [tplId]: { ...ch, [slot]: i } }); reset(); };

  const run = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    const res = await act(fn);
    await load();
    setBusy(false);
    return res;
  };

  const registerBrand = async () => {
    const res = await run(() => api<{ brandId: string; name: string }>('/brands', { body: { name: trimmed, logo } }));
    if (res) {
      setBrandSel(res.brandId);
      setNewName('');
      notify('Brand registered', `${res.name} is yours. Reputation starts at ${data.rules.startingReputation}.`);
    }
  };

  const save = async () => {
    if (!brand) return;
    const res = await run(() => api<{ productId: string; name: string }>('/designs', { body: { brandId: brand.id, templateId: tplId, slots: ch, tier, priceCents: Math.round(price * 100) } }));
    if (res) {
      notify('Design saved', ownsBuilding
        ? `${res.name} can now be made at your ${building.name}. Pick it as the recipe on the building.`
        : `${res.name} is ready. Build a ${building.name} (Lv ${building.unlockLevel}) to make it.`);
    }
  };

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
              {TEMPLATES.map((t) => {
                const b = buildingTypeById(t.buildingTypeId);
                return (
                  <button key={t.id} type="button" role="radio" aria-checked={t.id === tplId} className="option" style={{ minHeight: 72 }} onClick={() => { setTplId(t.id); reset(); }}>
                    <strong style={{ fontSize: 15 }}>{t.label}</strong>
                    <span className="small muted">{b.name} · Lv {b.unlockLevel}</span>
                  </button>
                );
              })}
            </div>
            {!ownsBuilding && <span className="small muted">You don’t own a {building.name} yet. You can design now and build one later.</span>}
          </Card>

          <Card title="2 · Materials" action={<span className="muted" style={{ fontSize: 13 }}>Extra cost per unit, on top of the normal recipe</span>}>
            {tpl.slots.map((s) => (
              <fieldset key={s.key} style={{ border: 0, margin: 0, padding: 0 }}>
                <legend className="muted" style={{ fontSize: 13, marginBottom: 8 }}>{s.label}</legend>
                <div className="row" style={{ gap: 8 }}>
                  {s.options.map((o, i) => (
                    <button key={o.name} type="button" aria-pressed={(ch[s.key] ?? 0) === i} className="option inline" onClick={() => pick(s.key, i)}>
                      {o.name}<span className="mono small muted">{o.surcharge ? `+${num(o.surcharge)} CR` : 'included'}</span>
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
                  {VARIANT_TIERS[k].minReputation > 0 && <span className="small muted">Brand reputation {VARIANT_TIERS[k].minReputation}+</span>}
                </button>
              ))}
            </div>
          </Card>

          <Card title="4 · Brand">
            <div role="radiogroup" aria-label="Brand" className="grid-auto-sm">
              {data.brands.map((b) => (
                <button key={b.id} type="button" role="radio" aria-checked={b.id === brandId} className="option" onClick={() => setBrandSel(b.id)}>
                  <span className="row" style={{ gap: 8, color: 'var(--gold)' }}><LogoGlyph d={LOGOS[b.logo]?.d ?? LOGOS[0].d} size={18} /><strong style={{ color: 'var(--text)' }}>{b.name}</strong></span>
                  <span className="mono small muted">Reputation {Math.round(b.reputation)} · {b.designs}/{data.rules.maxDesignsPerBrand} designs</span>
                </button>
              ))}
              {canAddBrand && (
                <button type="button" role="radio" aria-checked={creating} className="option" onClick={() => setBrandSel(NEW_BRAND)}>
                  <strong>+ New brand</strong>
                  <span className="mono small muted">{num(data.rules.fee)} CR to register</span>
                </button>
              )}
            </div>
            {creating && (
              <>
                <div className="row" style={{ alignItems: 'flex-end', gap: 16 }}>
                  <label className="field" style={{ flex: '1 1 260px' }}>
                    Brand name
                    <input className="input" value={newName} maxLength={data.rules.maxLength} aria-invalid={!!nameProblem} placeholder={`${company?.name.split(' ')[0] ?? 'Your'} Atelier`} onChange={(e) => setNewName(e.target.value)} />
                  </label>
                  <div role="radiogroup" aria-label="Logo" className="row" style={{ gap: 8 }}>
                    {LOGOS.map((l, i) => (
                      <button key={l.name} type="button" role="radio" aria-checked={i === logo} aria-label={`${l.name} logo`} className="option" style={{ width: 48, height: 48, padding: 0, alignItems: 'center', justifyContent: 'center', color: 'var(--gold)' }} onClick={() => setLogo(i)}>
                        <LogoGlyph d={l.d} />
                      </button>
                    ))}
                  </div>
                </div>
                <span className={nameProblem ? 'loss' : nameReady ? 'gain' : 'muted'} style={{ fontSize: 13 }}>
                  {!trimmed ? `${data.rules.minLength}–${data.rules.maxLength} characters. Names are unique across the server.` : nameProblem ?? (nameReady ? 'Available · checked for uniqueness and profanity' : 'Checking…')}
                </span>
                <button type="button" className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} disabled={!nameReady || busy || cash < data.rules.fee} onClick={() => void registerBrand()}>
                  {cash < data.rules.fee ? 'Not enough cash' : `Register for ${num(data.rules.fee)} CR`}
                </button>
              </>
            )}
          </Card>

          {data.designs.length > 0 && (
            <Card title="Your designs">
              <div className="stack" style={{ gap: 12 }}>
                {data.designs.map((d) => {
                  const where = data.buildings.filter((b) => d.buildings.includes(b.id));
                  const candidates = data.buildings.filter((b) => b.typeId === d.buildingTypeId);
                  return (
                    <div key={d.id} className="row" style={{ gap: 14, flexWrap: 'nowrap', alignItems: 'center' }}>
                      <img src={d.art} alt="" width={52} height={52} style={{ objectFit: 'contain', flexShrink: 0 }} />
                      <div className="stack-sm" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                        <strong>{d.name}</strong>
                        <span className="small muted">{d.materials.join(' · ')} · {dec(toCr(d.priceCents))} CR · {num(d.stock)} in stock</span>
                        <span className="small">
                          {where.length
                            ? <>Made at {where.map((b, i) => <span key={b.id}>{i > 0 && ', '}<Link to={`/app/buildings/${b.id}`}>{b.name}</Link></span>)}</>
                            : candidates.length
                              ? <span className="muted">Not in production · set it as the recipe on <Link to={`/app/buildings/${candidates[0].id}`}>{candidates[0].name}</Link></span>
                              : <span className="muted">Needs a {buildingTypeById(d.buildingTypeId).name}</span>}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </div>

        <div className="side stack" style={{ gap: 24 }}>
          <Card className="flush">
            <div className="stack" style={{ background: 'var(--raised)', padding: 24, gap: 14 }}>
              <div className="art-stage" style={{ height: 200, borderRadius: 14, background: stage }}>
                <img src={art} alt={`${variant.label} ${tpl.label} preview`} width={190} height={190} style={{ objectFit: 'contain' }} />
              </div>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <span style={{ width: 52, height: 52, borderRadius: 14, background: 'var(--gold-wash)', color: 'var(--gold)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <LogoGlyph d={LOGOS[creating ? logo : brand!.logo]?.d ?? LOGOS[0].d} size={28} />
                </span>
                <div className="stack-sm" style={{ gap: 2 }}>
                  <span className="goldtx" style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase' }}>{displayBrand}</span>
                  <strong className="disp" style={{ fontSize: 22, fontWeight: 600 }}>{variant.label} {tpl.label}</strong>
                </div>
              </div>
              <span className="muted" style={{ fontSize: 13 }}>{picked.map((p) => p.name).join(' · ')}</span>
              <span className="chip mono" style={{ alignSelf: 'flex-start', background: 'var(--info-wash)', color: 'var(--info-soft)' }}>Made at: {building.name}</span>
            </div>
            <div className="stack" style={{ padding: 20, gap: 12 }}>
              <h2 className="h-section" style={{ fontSize: 18 }}>5 · Value check</h2>
              <div className="stack-sm mono" style={{ fontSize: 13 }}>
                <div className="row-between"><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Recipe inputs per unit</span><span>{dec(econ.recipeInputs)}</span></div>
                <div className="row-between"><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Materials per unit</span><span>{dec(econ.materials)}</span></div>
                <div className="row-between"><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Inputs × {variant.inputMult} ({variant.label})</span><span>{dec(econ.inputs)}</span></div>
                <div className="row-between"><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Op cost per unit</span><span>{dec(econ.op)}</span></div>
                <div className="row-between"><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Value cap (inputs × 1.8 + op)</span><span>{dec(econ.valueCap)}</span></div>
                <div className="row-between"><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Price band (ref × {variant.bandMult})</span><span>{dec(econ.bandCap)}</span></div>
              </div>
              <div className="field">
                Target wholesale price
                <Stepper
                  value={`${num(price)} CR`}
                  decLabel="Lower price"
                  incLabel="Raise price"
                  onDec={() => setPriceOverride(Math.max(1, price - step))}
                  onInc={() => setPriceOverride(Math.min(econ.maxPrice, price + step))}
                />
              </div>
              <ProgressBar value={price / econ.maxPrice} size="thin" color="var(--gain)" label="Price against the cap" />
              {margin > 0 ? (
                <Callout tone="ok" title="Passes value check">
                  Max {num(econ.maxPrice)} CR · margin ≈ {dec(margin)} CR per unit after the 2% fee
                  {brand ? `, before the +${Math.round((reputationPriceMultiplier(brand.reputation) - 1) * 100)}% reputation premium from NPC buyers` : ''}
                </Callout>
              ) : (
                <Callout tone="bad" title="No margin at this price">Raise the price (max {num(econ.maxPrice)} CR) or pick cheaper materials.</Callout>
              )}
              {repTooLow && <Callout tone="bad" title={`${variant.label} needs reputation ${variant.minReputation}`}>Sell basic or premium goods under this brand to build it up.</Callout>}
              {brandFull && <Callout tone="bad" title="Brand is full">{brand!.name} already has {data.rules.maxDesignsPerBrand} designs.</Callout>}
              <button type="button" className="btn btn-primary btn-lg" disabled={creating || repTooLow || brandFull || busy} onClick={() => void save()}>
                {creating ? 'Register the brand first' : 'Save design'}
              </button>
            </div>
          </Card>

          <Card title="Your brands">
            {data.brands.length === 0 && <span className="muted">No brands yet. Register one in step 4.</span>}
            {data.brands.map((b) => (
              <div key={b.id} className="stack-sm" style={{ gap: 6 }}>
                <div className="row-between"><strong>{b.name}</strong><span className="mono">{Math.round(b.reputation)} / 100</span></div>
                <ProgressBar value={b.reputation / 100} label={`${b.name} reputation`} />
                <span className={`small ${b.idleDays >= 2 ? 'loss' : 'muted'}`}>
                  {b.designs} design{b.designs === 1 ? '' : 's'} · +{dec((reputationPriceMultiplier(b.reputation) - 1) * 100)}% NPC price
                  {b.lastDay && b.lastDay.units > 0 ? ` · ${num(b.lastDay.units)} sold to ${num(b.lastDay.buyers)} buyers yesterday` : ''}
                  {b.idleDays >= 2 ? ` · no sales for ${b.idleDays} days, losing 1% a day` : ''}
                </span>
              </div>
            ))}
            <span className="small muted">Reputation grows with units sold to distinct buyers, their quality and on-time contract deliveries, and decays 1% a day. It adds up to +20% to what NPC buyers pay.</span>
          </Card>
        </div>
      </section>
    </>
  );
}
