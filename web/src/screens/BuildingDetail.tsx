import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TopBar } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { Card, ProgressBar, QualityStars, TierChip } from '../components/ui';
import { buildingTypeById, productById, recipeText } from '../data/catalog';
import type { BuildingType } from '../data/types';
import { netPerDay, npcPriceMultiplier, outputQuality, upgradeCost } from '../lib/economy';
import { dec, duration, num } from '../lib/format';
import { useGame } from '../state/game';
import type { ServerDesign } from '../api/types';
import { api } from '../api/client';
import { BUILDING_FAMILY, FAMILIES, RESEARCH_PRODUCT, researchBonus, researchTier } from '../../../shared/research';
import { designEconomics, VARIANT_TIERS, variantInputQty } from '../../../shared/designer';

/** Mirrors server/src/production.ts: research bonus, and a design's extra inputs, materials and price. */
function economics(type: BuildingType, level: number, lotQ: number, bonus: number, design?: ServerDesign) {
  const out = type.outputs[0];
  const outQ = out.productId === RESEARCH_PRODUCT ? 0 : outputQuality([lotQ], bonus);
  const pOut = (design ? design.priceCents / 100 : productById(out.productId).refPrice) * npcPriceMultiplier(outQ);
  const inputs = type.inputs.map((i) => ({
    qty: design ? variantInputQty(i.qty, level, design.tier) : i.qty * level,
    price: productById(i.productId).refPrice * npcPriceMultiplier(lotQ),
  }));
  const materials = design ? designEconomics(design).materials * VARIANT_TIERS[design.tier].inputMult * out.qty * level : 0;
  const net = netPerDay({
    output: { qty: out.qty * level, price: pOut },
    inputs,
    opCost: type.opCost * level + materials,
    upkeepPerDay: type.upkeepPerDay * level,
    cyclesPerDay: 24 / type.cycleHours,
  });
  return { outQ, pOut, net, materials, revenue: out.qty * level * pOut * 0.98 };
}

export function BuildingDetail() {
  const { id } = useParams();
  const { buildings, inventory, cash, collect, startJob, upgrade, npcBuy, me, company, act, notify } = useGame();
  const b = buildings.find((x) => x.id === id);
  const [pickedQ, setPickedQ] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  if (!b) {
    return (
      <div className="stack" style={{ paddingTop: 32 }}>
        <h1 className="h-page">Building not found</h1>
        <Link to="/app">← Back to Headquarters</Link>
      </div>
    );
  }

  const type = buildingTypeById(b.typeId);
  const hasRecipe = type.outputs.length > 0;
  const nextCost = upgradeCost(type.buildCost, b.level + 1);
  const primary = type.inputs[0] ? productById(type.inputs[0].productId) : null;
  const designId = me?.buildings.find((x) => x.id === b.id)?.designId ?? null;
  const myDesigns = (me?.designs ?? []).filter((d) => d.companyId === company?.id && d.buildingTypeId === type.id);
  const design = myDesigns.find((d) => d.id === designId);
  const family = BUILDING_FAMILY[type.id];
  const familyName = FAMILIES.find((f) => f.id === family)?.name;
  const tier = family && me ? researchTier(me.research[family] ?? 0) : 0;
  const lineQty = (qty: number, level: number) => (design ? variantInputQty(qty, level, design.tier) : qty * level);
  const need = (productId: string) => lineQty(type.inputs.find((i) => i.productId === productId)?.qty ?? 0, b.level);
  const have = (productId: string) => inventory.filter((l) => l.productId === productId).reduce((s, l) => s + l.qty, 0);
  const lots = primary ? inventory.filter((l) => l.productId === primary.id && l.qty >= need(primary.id)) : [];
  const lotQ = pickedQ ?? lots[lots.length - 1]?.quality ?? 0;
  const missing = type.inputs.filter((i) => have(i.productId) < need(i.productId));
  const canStart = hasRecipe && b.status === 'idle' && missing.length === 0 && (!primary || lots.length > 0);

  const bonus = family ? researchBonus(tier, lotQ) : 0;
  const now = hasRecipe ? economics(type, b.level, lotQ, bonus, design) : null;
  const upgraded = hasRecipe ? economics(type, b.level + 1, lotQ, bonus, design) : null;
  const upgradePayback = now && upgraded && upgraded.net > now.net ? nextCost / (upgraded.net - now.net) : null;
  const outName = design ? design.name : type.outputs[0] ? productById(type.outputs[0].productId).name.toLowerCase() : '';

  const chooseRecipe = async (next: string | null) => {
    setBusy(true);
    const res = await act(() => api(`/buildings/${b.id}/design`, { body: { designId: next } }));
    setBusy(false);
    if (res) notify('Recipe changed', next ? `${b.name} will make ${myDesigns.find((d) => d.id === next)?.name} from the next cycle.` : `${b.name} is back on its normal recipe.`);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };

  const buyMissing = async () => {
    for (const i of missing) {
      const p = productById(i.productId);
      if (!p.npcVendor) continue;
      const ok = await npcBuy(i.productId, need(i.productId) - have(i.productId));
      if (!ok) return;
    }
  };
  const vendorCost = missing.reduce((s, i) => {
    const p = productById(i.productId);
    return p.npcVendor ? s + (need(i.productId) - have(i.productId)) * p.refPrice : s;
  }, 0);
  const nonVendorMissing = missing.filter((i) => !productById(i.productId).npcVendor);

  return (
    <>
      <TopBar title={`${b.name} · Lv ${b.level}`} subtitle={`Plot ${b.plot.row * 4 + b.plot.col + 1} · ${type.name}`} />
      <Link to="/app" className="row small" style={{ gap: 6, marginTop: -8 }}><Icon name="back" size={16} />Back to Headquarters</Link>

      <section className="split">
        <Card className="flush" style={{ flex: '1 1 320px' }}>
          <div className="art-stage" style={{ paddingTop: 16 }}>
            <img src={type.art} alt={`${type.name}, level ${b.level}`} width={300} height={270} />
          </div>
          <div style={{ padding: 20, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '14px 20px', fontSize: 13 }}>
            <Spec label="Category" value={<TierChip tier={type.tag} />} />
            <Spec label="Cycle" value={`${type.cycleHours}h · ${24 / type.cycleHours}/day`} />
            <Spec label="Output / cycle" value={type.outputs[0] ? `${num(type.outputs[0].qty * b.level)} ${outName}` : '—'} />
            {family && <Spec label="Research" value={`${familyName} · Q${tier}`} />}
            <Spec label="Workers" value={num(b.level * 10)} />
            <Spec label="Op cost / cycle" value={`${num(type.opCost * b.level)} CR`} />
            <Spec label="Est. net / day" value={b.netPerDay ? `+${num(b.netPerDay)}` : '—'} />
          </div>
        </Card>

        <div className="stack" style={{ flex: '2 1 520px', minWidth: 0, gap: 24 }}>
          <Card
            title="Current job"
            action={<span className="chip" style={{ background: b.status === 'ready' ? 'var(--gold-wash)' : b.status === 'running' ? 'var(--gain-wash)' : 'var(--line)', color: b.status === 'ready' ? 'var(--gold)' : b.status === 'running' ? 'var(--gain)' : 'var(--text-soft)' }}>{b.status[0].toUpperCase() + b.status.slice(1)}</span>}
          >
            <div className="muted">{recipeText(type)}</div>
            {b.status === 'running' && (
              <>
                <ProgressBar value={b.progress} size="thick" label="Job progress" />
                <div className="row-between mono small muted">
                  <span>{Math.round(b.progress * 100)}%</span>
                  <span>{duration(b.minutesLeft)} game time left</span>
                </div>
              </>
            )}
            {b.status === 'ready' && b.readyOutput && (
              <div className="row-between">
                <span>{num(b.readyOutput.qty)} {productById(b.readyOutput.productId).name.toLowerCase()} · <QualityStars q={b.readyOutput.quality} /></span>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => collect([b.id]))}>Collect &amp; restart</button>
              </div>
            )}
            {b.status === 'idle' && !hasRecipe && <p className="muted">Retail buildings don’t run production jobs yet.</p>}
            {b.status === 'idle' && hasRecipe && <p className="muted">Idle. Choose a lot below and start a job.</p>}
          </Card>

          {myDesigns.length > 0 && type.outputs[0] && (
            <Card title="Recipe" action={<Link to="/app/designer" className="small">Product designer</Link>}>
              <div className="grid-auto-sm" role="radiogroup" aria-label="Recipe">
                <button type="button" role="radio" aria-checked={!design} className="option" disabled={busy} onClick={() => void chooseRecipe(null)}>
                  <strong>{productById(type.outputs[0].productId).name}</strong>
                  <span className="small muted">Normal recipe</span>
                </button>
                {myDesigns.map((d) => (
                  <button key={d.id} type="button" role="radio" aria-checked={d.id === designId} className="option" disabled={busy} onClick={() => void chooseRecipe(d.id)}>
                    <strong>{d.name}</strong>
                    <span className="small muted">{VARIANT_TIERS[d.tier].label} · ×{VARIANT_TIERS[d.tier].inputMult} inputs · {dec(d.priceCents / 100)} CR</span>
                  </button>
                ))}
              </div>
              <span className="small muted">A new recipe applies from the next cycle.</span>
            </Card>
          )}

          {hasRecipe && now && (
            <Card title={b.status === 'idle' ? 'Start a job' : 'Next job preview'}>
              {primary && (
                <fieldset style={{ border: 0, margin: 0, padding: 0 }} className="stack-sm">
                  <legend className="muted" style={{ fontSize: 13, marginBottom: 10 }}>{primary.name} lot (needs {num(need(primary.id))})</legend>
                  {lots.length > 0 ? (
                    <div className="grid-auto-sm" role="radiogroup">
                      {lots.map((l) => (
                        <button key={l.quality} type="button" role="radio" aria-checked={l.quality === lotQ} className="option" onClick={() => setPickedQ(l.quality)}>
                          <strong>Q{l.quality} lot</strong>
                          <span className="mono small muted">{num(l.qty)} in stock</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="muted">No lot with enough {primary.name.toLowerCase()}.</span>
                  )}
                </fieldset>
              )}
              {missing.length > 0 && (
                <div className="inset stack-sm">
                  <span>Missing inputs: {missing.map((i) => `${num(need(i.productId) - have(i.productId))} ${productById(i.productId).name.toLowerCase()}`).join(', ')}</span>
                  <div className="row">
                    {vendorCost > 0 && (
                      <button type="button" className="btn btn-secondary" disabled={busy || vendorCost > cash} onClick={() => void run(buyMissing)}>
                        Buy from NPC vendor · {dec(vendorCost)} CR
                      </button>
                    )}
                    {nonVendorMissing.length > 0 && <Link to="/app/market" className="btn btn-ghost">Buy on the exchange</Link>}
                  </div>
                </div>
              )}
              <div className="grid-auto-sm">
                <div className="inset stack-sm">
                  <span className="small muted">Output quality</span>
                  <span className="stat-value sm"><QualityStars q={now.outQ} /></span>
                  <span className="small muted">
                    {!family
                      ? 'min(input Q + research, lowest input + 1)'
                      : bonus
                        ? `+1 from ${familyName} research (Q${tier})`
                        : tier > 0 ? `${familyName} research Q${tier} is not above the inputs` : `No ${familyName} research yet`}
                  </span>
                </div>
                <div className="inset stack-sm">
                  <span className="small muted">Value / cycle at ref (after 2% fee)</span>
                  <span className="stat-value sm">{num(now.revenue)} CR</span>
                  <span className="small muted">{num(type.outputs[0].qty * b.level)} × {dec(now.pOut)} × 0.98{now.materials ? ` · materials ${num(now.materials)} CR` : ''}</span>
                </div>
                <div className="inset stack-sm">
                  <span className="small muted">Projected net / day</span>
                  <span className={`stat-value sm ${now.net >= 0 ? 'gain' : 'loss'}`}>{now.net >= 0 ? '+' : ''}{num(now.net)}</span>
                  <span className="small muted">{24 / type.cycleHours} × (revenue − inputs − op) − upkeep</span>
                </div>
              </div>
              {b.status === 'idle' && (
                <button type="button" className="btn btn-primary btn-lg" style={{ alignSelf: 'flex-start' }} disabled={!canStart || busy} onClick={() => void run(() => startJob(b.id, primary ? lotQ : undefined))}>
                  Start production
                </button>
              )}
            </Card>
          )}
        </div>
      </section>

      <Card title={`Upgrade to Lv ${b.level + 1}`}>
        <div className="grid-auto-sm">
          <Row label="Cost" value={`${num(nextCost)} CR`} />
          {type.outputs[0] && <Row label="Output" value={<>{num(type.outputs[0].qty * b.level)} → <span className="gain">{num(type.outputs[0].qty * (b.level + 1))}</span></>} />}
          {upgradePayback && <Row label="Payback" value={`≈ ${Math.round(upgradePayback)} days`} />}
        </div>
        <span className="small muted">Cost = {num(type.buildCost)} × 1.12^{b.level}. From Lv 10, 30% will be paid in construction units.</span>
        <button type="button" className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} disabled={busy || nextCost > cash} onClick={() => void run(() => upgrade(b.id))}>
          {nextCost > cash ? 'Not enough cash' : `Upgrade for ${num(nextCost)} CR`}
        </button>
      </Card>
    </>
  );
}

function Spec({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stack-sm" style={{ gap: 2 }}>
      <span className="muted">{label}</span>
      <span className="mono" style={{ fontSize: 15 }}>{value}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="inset stack-sm" style={{ gap: 4 }}>
      <span className="small muted">{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}
