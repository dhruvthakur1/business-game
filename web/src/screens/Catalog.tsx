import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGame } from '../state/game';
import { TopBar } from '../components/AppShell';
import { Card, QualityFrame, QualityStars, Segmented, TierChip } from '../components/ui';
import { BUILDING_TYPES, PRODUCTS, recipeText } from '../data/catalog';
import { GALLERY, LADDERS } from '../data/lifestyle';
import { dec, num } from '../lib/format';

type Tab = 'buildings' | 'goods' | 'luxury';

export function Catalog() {
  const [tab, setTab] = useState<Tab>('buildings');
  const { company, cash, buyBuilding } = useGame();
  const navigate = useNavigate();
  const [building, setBuilding] = useState<string | null>(null);
  const build = async (typeId: string) => {
    setBuilding(typeId);
    const id = await buyBuilding(typeId);
    setBuilding(null);
    if (id) navigate(`/app/buildings/${id}`);
  };
  const goods = PRODUCTS.filter((p) => p.art && p.tier !== 'T7' && !['economy_car', 'suv', 'sports_car', 'smartphone', 'laptop'].includes(p.id));
  const bread = PRODUCTS.find((p) => p.id === 'bread')!;

  return (
    <>
      <TopBar title="Catalog" subtitle="Every building and product in the launch set" />
      <Segmented label="Catalog section" boxed value={tab} onChange={setTab} options={[{ value: 'buildings', label: 'Buildings' }, { value: 'goods', label: 'Production goods' }, { value: 'luxury', label: 'Luxury & lifestyle' }]} />

      {tab === 'buildings' && (
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 20 }}>
          {BUILDING_TYPES.map((t) => (
            <article key={t.id} className="card flush">
              <div className="art-stage" style={{ paddingTop: 8, background: '#161b23' }}>
                <img src={t.art} alt={`${t.name} model`} width={240} height={216} />
              </div>
              <div className="stack-sm" style={{ padding: '18px 20px 20px', gap: 10 }}>
                <div className="row-between" style={{ flexWrap: 'nowrap' }}>
                  <strong className="disp" style={{ fontSize: 18, fontWeight: 600 }}>{t.name}</strong>
                  <TierChip tier={t.tag} />
                </div>
                <span className="muted" style={{ fontSize: 13, minHeight: 38 }}>{recipeText(t)}</span>
                <div className="mono" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, fontSize: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                  <span className="stack-sm" style={{ gap: 2 }}><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Build</span>{num(t.buildCost)}</span>
                  <span className="stack-sm" style={{ gap: 2 }}><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Net/day</span><span className="gain">{t.netLabel}</span></span>
                  <span className="stack-sm" style={{ gap: 2 }}><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Unlock</span>Lv {t.unlockLevel}</span>
                </div>
                {(() => {
                  const locked = (company?.level ?? 1) < t.unlockLevel;
                  const poor = cash < t.buildCost;
                  return (
                    <button type="button" className="btn btn-secondary" disabled={locked || poor || building !== null} onClick={() => void build(t.id)}>
                      {locked ? `Unlocks at Lv ${t.unlockLevel}` : poor ? 'Not enough cash' : building === t.id ? 'Building…' : `Build for ${num(t.buildCost)} CR`}
                    </button>
                  );
                })()}
              </div>
            </article>
          ))}
        </section>
      )}

      {tab === 'goods' && (
        <>
          <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 }}>
            {goods.map((p) => (
              <article key={p.id} className="card" style={{ padding: 12, gap: 6, alignItems: 'center' }}>
                <img src={p.art} alt={p.name} width={104} height={104} />
                <strong>{p.name}</strong>
                <div className="row" style={{ gap: 6 }}>
                  <TierChip tier={p.tier} short />
                  <span className="mono small muted">{dec(p.refPrice)}{p.unit ? ` / ${p.unit}` : ''}</span>
                </div>
              </article>
            ))}
          </section>
          <Card title="Quality is a frame, not a new drawing">
            <p className="muted" style={{ fontSize: 13 }}>The same art is reused at every quality. The tile changes, so Q5 bread still stands out in a warehouse list.</p>
            <div className="grid-auto-sm" style={{ maxWidth: 560 }}>
              {[0, 2, 5].map((q) => (
                <QualityFrame key={q} q={q}>
                  <img src={bread.art} alt={`Bread, quality ${q}`} width={96} height={96} />
                  <QualityStars q={q} />
                </QualityFrame>
              ))}
            </div>
          </Card>
        </>
      )}

      {tab === 'luxury' && (
        <>
          {LADDERS.filter((l) => l.rungs.some((r) => r.art)).map((l) => (
            <Card key={l.id} title={l.label}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 14 }}>
                {l.rungs.filter((r) => r.art).map((r, i) => (
                  <article key={r.name} className="flush" style={{ background: 'var(--raised)', borderRadius: 14, overflow: 'hidden', border: `1px solid ${i === l.rungs.length - 1 ? 'var(--gold-edge)' : 'transparent'}` }}>
                    <div className="art-stage" style={{ height: 150 }}><img src={r.art} alt={r.name} style={{ width: '100%', height: 140, objectFit: 'contain' }} /></div>
                    <div className="stack-sm" style={{ padding: '12px 14px', gap: 4 }}>
                      <strong>{r.name}</strong>
                      <span className="mono small muted">{r.price === null ? 'auction' : `${num(r.price)} CR`}</span>
                    </div>
                  </article>
                ))}
              </div>
            </Card>
          ))}
          <Card title="Jewelry, fashion, big-ticket & electronics">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 14 }}>
              {[...GALLERY.luxury, ...GALLERY.big].map((g) => (
                <article key={g.name} style={{ background: 'var(--raised)', borderRadius: 14, overflow: 'hidden' }}>
                  <div className="art-stage" style={{ height: 150 }}><img src={g.art} alt={g.name} style={{ width: '100%', height: 136, objectFit: 'contain' }} /></div>
                  <div className="stack-sm" style={{ padding: '12px 14px', gap: 4 }}>
                    <strong>{g.name}</strong>
                    <span className="mono small muted">{g.price}</span>
                  </div>
                </article>
              ))}
            </div>
          </Card>
        </>
      )}
    </>
  );
}
