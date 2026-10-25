import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brandNameProblem, designEconomics, nextReputation, reputationPriceMultiplier } from '../../shared/designer';
import { researchBonus, researchTier } from '../../shared/research';
import { createDesign, registerBrand, updateReputation } from '../src/brands';
import { type Db, withTx } from '../src/db';
import { npcSell } from '../src/npc';
import { buyBuilding, collect, setBuildingDesign, startJob } from '../src/production';
import { addResearch, applyPoints, setFocus } from '../src/research';
import { gameDay } from '../src/time';
import { cash, freshDb, give, goods, ledgerTotal, newCompany } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

const finishNow = (buildingId: string) =>
  db.query("UPDATE production_jobs SET finishes_at = now() - interval '1 second' WHERE building_id = $1 AND state = 'running'", [buildingId]);
const points = async (companyId: string, family: string) =>
  (await db.query<{ points: number }>('SELECT points FROM company_research WHERE company_id = $1 AND family = $2', [companyId, family])).rows[0]?.points ?? 0;

describe('research rules', () => {
  it('maps points to tiers at 50 / 250 / 1.5k / 6k / 20k', () => {
    expect(researchTier(0)).toBe(0);
    expect(researchTier(49)).toBe(0);
    expect(researchTier(50)).toBe(1);
    expect(researchTier(1499)).toBe(2);
    expect(researchTier(20000)).toBe(5);
  });

  it('gives +1 quality only while the tier is above the inputs', () => {
    expect(researchBonus(0, 0)).toBe(0);
    expect(researchBonus(1, 0)).toBe(1);
    expect(researchBonus(2, 1.5)).toBe(1);
    expect(researchBonus(2, 2)).toBe(0);
  });
});

describe('R&D labs and research points', () => {
  it('sends lab output to the focus family, or to the warehouse without a focus', async () => {
    const c = await newCompany(db);
    const lab = await withTx(db, (tx) => buyBuilding(tx, c.id, 'rnd_lab'));
    await give(db, c.id, 'mwh', 0, 10);

    await withTx(db, (tx) => startJob(tx, c.id, lab.id));
    await finishNow(lab.id);
    await withTx(db, (tx) => collect(tx, c.id, { restart: false }));
    expect(await goods(db, c.id, 'research_points', 0)).toBe(25);

    await withTx(db, (tx) => setFocus(tx, c.id, 'food'));
    await withTx(db, (tx) => startJob(tx, c.id, lab.id));
    await finishNow(lab.id);
    const [res] = await withTx(db, (tx) => collect(tx, c.id, { restart: false }));
    expect(res.researchFamily).toBe('food');
    expect(await points(c.id, 'food')).toBe(25);
    expect(await goods(db, c.id, 'research_points', 0)).toBe(25);
  });

  it('applies points from the warehouse and pays the first-to-tier bonus once', async () => {
    const a = await newCompany(db);
    const b = await newCompany(db);
    await give(db, a.id, 'research_points', 0, 300);
    await give(db, b.id, 'research_points', 0, 300);

    const first = await withTx(db, (tx) => applyPoints(tx, a.id, 'textiles', 260));
    expect(first.tiersReached).toEqual([1, 2]);
    expect(first.firsts).toEqual([1, 2]);
    const second = await withTx(db, (tx) => applyPoints(tx, b.id, 'textiles', 260));
    expect(second.tiersReached).toEqual([1, 2]);
    expect(second.firsts).toEqual([]);

    const xp = await db.query<{ n: number }>("SELECT COALESCE(SUM(amount), 0)::int AS n FROM xp_events WHERE company_id = $1 AND source = 'research'", [a.id]);
    expect(xp.rows[0].n).toBe(1000);
    expect(await goods(db, a.id, 'research_points', 0)).toBe(40);
    await expect(withTx(db, (tx) => applyPoints(tx, a.id, 'textiles', 100))).rejects.toMatchObject({ code: 'insufficient_goods' });
  });

  it('lifts output quality one step above the inputs with research', async () => {
    const c = await newCompany(db);
    const mill = await withTx(db, (tx) => buyBuilding(tx, c.id, 'mill'));
    await give(db, c.id, 'wheat', 1, 200);

    const plain = await withTx(db, (tx) => startJob(tx, c.id, mill.id));
    expect(plain.outputQuality).toBe(1);
    await finishNow(mill.id);
    await withTx(db, (tx) => collect(tx, c.id, { restart: false }));

    await withTx(db, (tx) => addResearch(tx, c.id, 'food', 250, 'applied'));
    const researched = await withTx(db, (tx) => startJob(tx, c.id, mill.id));
    expect(researched.outputQuality).toBe(2);
  });
});

describe('brands', () => {
  it('validates names: length, characters, profanity and uniqueness (case-insensitive)', async () => {
    expect(brandNameProblem('ab')).toMatch(/At least 3/);
    expect(brandNameProblem('Good <Brand>')).toMatch(/Letters/);
    expect(brandNameProblem('Sh1t Co')).toBeNull();
    expect(brandNameProblem('ShitCo')).toMatch(/not allowed/);
    expect(brandNameProblem("Maison d'Or & Co.")).toBeNull();

    const a = await newCompany(db);
    const b = await newCompany(db);
    const before = await cash(db, a.id);
    await withTx(db, (tx) => registerBrand(tx, a.id, { name: 'Aurora Works', logo: 1 }));
    expect(before - (await cash(db, a.id))).toBe(500_000);
    await expect(withTx(db, (tx) => registerBrand(tx, b.id, { name: '  aurora   WORKS ', logo: 0 }))).rejects.toMatchObject({ code: 'brand_name' });
  });

  it('limits a company to three brands', async () => {
    const c = await newCompany(db);
    for (const n of ['One Brand', 'Two Brand', 'Three Brand']) await withTx(db, (tx) => registerBrand(tx, c.id, { name: n, logo: 0 }));
    await expect(withTx(db, (tx) => registerBrand(tx, c.id, { name: 'Four Brand', logo: 0 }))).rejects.toMatchObject({ code: 'brand_limit' });
  });

  it('moves reputation: 1% decay, growth from sales, capped at 100', () => {
    expect(nextReputation(50, { units: 0, buyers: 0, avgQuality: 0, onTimeDeliveries: 0 })).toBe(49.5);
    expect(nextReputation(50, { units: 400, buyers: 10, avgQuality: 2, onTimeDeliveries: 0 })).toBeGreaterThan(50);
    expect(nextReputation(100, { units: 10_000, buyers: 50, avgQuality: 5, onTimeDeliveries: 9 })).toBe(100);
    expect(reputationPriceMultiplier(50)).toBeCloseTo(1.1);
  });
});

describe('product designer', () => {
  it('computes the value cap from recipe inputs, materials and tier', () => {
    const basic = designEconomics({ templateId: 'loaf', slots: {}, tier: 'basic' });
    // 80 flour × 8 / 40 loaves = 16 CR inputs, 120 / 40 = 3 CR op; cap = min(16 × 1.8 + 3, 27 × 1.0)
    expect(basic.inputs).toBe(16);
    expect(basic.maxPrice).toBe(27);
    const premium = designEconomics({ templateId: 'loaf', slots: { grain: 1, finish: 1 }, tier: 'premium' });
    expect(premium.inputs).toBeCloseTo(30.8);
    expect(premium.maxPrice).toBe(45);
  });

  it('saves a design, makes it in the bakery with more inputs, and sells it with a reputation premium', async () => {
    const c = await newCompany(db);
    const { brandId } = await withTx(db, (tx) => registerBrand(tx, c.id, { name: 'Crumb & Crust', logo: 2 }));
    await expect(withTx(db, (tx) => createDesign(tx, c.id, { brandId, templateId: 'loaf', slots: { grain: 1, finish: 1 }, tier: 'premium', priceCents: 4600 })))
      .rejects.toMatchObject({ code: 'value_check' });
    await expect(withTx(db, (tx) => createDesign(tx, c.id, { brandId, templateId: 'loaf', slots: {}, tier: 'luxury', priceCents: 2000 })))
      .rejects.toMatchObject({ code: 'reputation' });
    const d = await withTx(db, (tx) => createDesign(tx, c.id, { brandId, templateId: 'loaf', slots: { grain: 1, finish: 1 }, tier: 'premium', priceCents: 4500 }));
    expect(d.name).toBe('Crumb & Crust Premium Bread');

    const bakery = await withTx(db, (tx) => buyBuilding(tx, c.id, 'bakery'));
    const mill = await withTx(db, (tx) => buyBuilding(tx, c.id, 'mill'));
    await expect(withTx(db, (tx) => setBuildingDesign(tx, c.id, mill.id, d.productId))).rejects.toMatchObject({ code: 'wrong_building' });
    await withTx(db, (tx) => setBuildingDesign(tx, c.id, bakery.id, d.productId));

    await give(db, c.id, 'flour', 0, 200);
    const before = await cash(db, c.id);
    await withTx(db, (tx) => startJob(tx, c.id, bakery.id));
    // 80 × 1.4 = 112 flour; op 120 CR; materials 6 CR × 1.4 × 40 = 336 CR
    expect(await goods(db, c.id, 'flour', 0)).toBe(88);
    expect(before - (await cash(db, c.id))).toBe(12_000 + 33_600);
    await finishNow(bakery.id);
    await withTx(db, (tx) => collect(tx, c.id, { restart: false }));
    expect(await goods(db, c.id, d.productId, 0)).toBe(40);

    // Reputation 10 → +2% on 45 CR.
    const sale = await withTx(db, (tx) => npcSell(tx, c.id, d.productId, 10, 0));
    expect(sale.proceedsCents).toBe(Math.round(10 * 4500 * 1.02));

    await withTx(db, (tx) => updateReputation(tx, c.id, gameDay()));
    const rep = await db.query<{ reputation: string }>('SELECT reputation FROM brands WHERE id = $1', [brandId]);
    expect(Number(rep.rows[0].reputation)).toBeGreaterThan(10);

    const totals = await ledgerTotal(db);
    expect(totals.balances).toBe(0);
    expect(totals.entries).toBe(0);
  });
});
