import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILDING_TYPE_DEFS, PRODUCT_DEFS } from '../../shared/catalog';
import { designEconomics } from '../../shared/designer';
import { BUILDING_FAMILY } from '../../shared/research';
import { createDesign, registerBrand } from '../src/brands';
import { createCompany } from '../src/companies';
import { type Db, withTx } from '../src/db';
import { buyBuilding, collect, setBuildingDesign, startJob } from '../src/production';
import { freshDb, give, goods } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

const finishNow = (buildingId: string) =>
  db.query("UPDATE production_jobs SET finishes_at = now() - interval '1 second' WHERE building_id = $1 AND state = 'running'", [buildingId]);

let n = 0;
const company = async (region = 'south') =>
  (await createCompany(db, { name: `Content Co ${++n}`, region, capitalCents: 2_000_000_00, level: 30 })).company.id;

/** Runs one cycle of a building and returns what it made. */
async function cycle(companyId: string, typeId: string) {
  const b = await withTx(db, (tx) => buyBuilding(tx, companyId, typeId));
  await withTx(db, (tx) => startJob(tx, companyId, b.id));
  await finishNow(b.id);
  const [out] = await withTx(db, (tx) => collect(tx, companyId, { restart: false }));
  return { building: b, out };
}

describe('Phase 2 buildings', () => {
  it('every recipe uses products that exist, and every new building has a research family', () => {
    const ids = new Set(PRODUCT_DEFS.map((p) => p.id));
    for (const t of BUILDING_TYPE_DEFS) for (const l of [...t.inputs, ...t.outputs]) expect(ids.has(l.productId), `${t.id}: ${l.productId}`).toBe(true);
    for (const id of ['cotton_farm', 'coal_mine', 'quarry', 'sand_pit', 'textile_mill', 'garment_factory', 'cement_plant']) {
      expect(BUILDING_FAMILY[id], id).toBeDefined();
    }
  });

  it('runs the textile chain: cotton → fabric → garments', async () => {
    const c = await company();
    await give(db, c, 'seeds', 0, 60);
    await give(db, c, 'fertilizer', 0, 20);
    await give(db, c, 'mwh', 0, 10);
    expect((await cycle(c, 'cotton_farm')).out).toMatchObject({ productId: 'cotton', qty: 80 });
    await give(db, c, 'cotton', 0, 20); // top up to the mill's 100
    expect((await cycle(c, 'textile_mill')).out).toMatchObject({ productId: 'fabric', qty: 60 });
    expect((await cycle(c, 'garment_factory')).out).toMatchObject({ productId: 'garments', qty: 30 });
    expect(await goods(db, c, 'fabric', 0)).toBe(20);
  });

  it('mines and quarries take 1 MWh, and East gets +10%', async () => {
    const east = await company('east');
    await give(db, east, 'mwh', 0, 10);
    expect((await cycle(east, 'coal_mine')).out).toMatchObject({ productId: 'coal', qty: 165 });
    expect((await cycle(east, 'quarry')).out).toMatchObject({ productId: 'limestone', qty: 220 });
    expect((await cycle(east, 'sand_pit')).out).toMatchObject({ productId: 'sand', qty: 330 });
  });

  it('makes cement from limestone, coal and power', async () => {
    const c = await company();
    await give(db, c, 'limestone', 0, 150);
    await give(db, c, 'coal', 0, 30);
    await give(db, c, 'mwh', 0, 3);
    expect((await cycle(c, 'cement_plant')).out).toMatchObject({ productId: 'cement', qty: 60 });
  });
});

describe('dress and sneaker designs', () => {
  it('prices against garments and is made at the Garment Factory', async () => {
    const silk = designEconomics({ templateId: 'dress', slots: { fabric: 2, trim: 2 }, tier: 'premium' });
    expect(silk.building.id).toBe('garment_factory');
    expect(silk.maxPrice).toBeGreaterThan(34);

    const c = await company();
    const { brandId } = await withTx(db, (tx) => registerBrand(tx, c, { name: 'Silk Road Studio', logo: 3 }));
    const d = await withTx(db, (tx) => createDesign(tx, c, { brandId, templateId: 'dress', slots: { fabric: 2, trim: 2 }, tier: 'premium', priceCents: silk.maxPrice * 100 }));
    expect(d.name).toBe('Silk Road Studio Premium Dress');

    const factory = await withTx(db, (tx) => buyBuilding(tx, c, 'garment_factory'));
    await withTx(db, (tx) => setBuildingDesign(tx, c, factory.id, d.productId));
    await give(db, c, 'fabric', 0, 56); // 40 × 1.4
    await give(db, c, 'mwh', 0, 2);
    await withTx(db, (tx) => startJob(tx, c, factory.id));
    await finishNow(factory.id);
    await withTx(db, (tx) => collect(tx, c, { restart: false }));
    expect(await goods(db, c, d.productId, 0)).toBe(30);
  });
});
