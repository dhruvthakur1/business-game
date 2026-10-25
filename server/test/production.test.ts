import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db, withTx } from '../src/db';
import { npcBuy, npcSaleValue, npcSell } from '../src/npc';
import { buyBuilding, collect, startJob, upgradeBuilding } from '../src/production';
import { cash, freshDb, give, goods, ledgerTotal, newCompany } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

const finishNow = (buildingId: string) =>
  db.query("UPDATE production_jobs SET finishes_at = now() - interval '1 second' WHERE building_id = $1 AND state = 'running'", [buildingId]);

describe('production', () => {
  it('runs a farm cycle end to end: build, buy inputs, start, collect once', async () => {
    const c = await newCompany(db, { capital: 100_000_00 });
    const farm = await withTx(db, (tx) => buyBuilding(tx, c.id, 'farm'));
    expect(await cash(db, c.id)).toBe(100_000_00 - 30_000_00);

    await withTx(db, (tx) => npcBuy(tx, c.id, 'seeds', 60));
    await withTx(db, (tx) => npcBuy(tx, c.id, 'fertilizer', 20));
    expect(await cash(db, c.id)).toBe(70_000_00 - 72_00 - 80_00);

    const job = await withTx(db, (tx) => startJob(tx, c.id, farm.id));
    expect(job.opCostCents).toBe(120_00);
    expect(await goods(db, c.id, 'seeds', 0)).toBe(0);

    // Not finished yet: nothing to collect.
    expect(await withTx(db, (tx) => collect(tx, c.id))).toEqual([]);

    await finishNow(farm.id);
    const first = await withTx(db, (tx) => collect(tx, c.id, { restart: false }));
    expect(first).toHaveLength(1);
    // North farms yield +10%: 100 × 1.1 = 110 wheat.
    expect(first[0]).toMatchObject({ productId: 'wheat', qty: 110, quality: 0 });
    expect(await goods(db, c.id, 'wheat', 0)).toBe(110);

    // Collecting again never double-credits.
    expect(await withTx(db, (tx) => collect(tx, c.id, { restart: false }))).toEqual([]);
    expect(await goods(db, c.id, 'wheat', 0)).toBe(110);
    expect((await ledgerTotal(db)).balances).toBe(0);
  });

  it('refuses to start without inputs and leaves cash untouched', async () => {
    const c = await newCompany(db);
    const mill = await withTx(db, (tx) => buyBuilding(tx, c.id, 'mill'));
    const before = await cash(db, c.id);
    await expect(withTx(db, (tx) => startJob(tx, c.id, mill.id))).rejects.toMatchObject({ code: 'missing_inputs' });
    expect(await cash(db, c.id)).toBe(before);
  });

  it('allows one job at a time per building', async () => {
    const c = await newCompany(db);
    const mill = await withTx(db, (tx) => buyBuilding(tx, c.id, 'mill'));
    await give(db, c.id, 'wheat', 1, 500);
    await withTx(db, (tx) => startJob(tx, c.id, mill.id));
    await expect(withTx(db, (tx) => startJob(tx, c.id, mill.id))).rejects.toMatchObject({ code: 'busy' });
  });

  it('caps output quality at the lowest input + 1', async () => {
    const c = await newCompany(db);
    const mill = await withTx(db, (tx) => buyBuilding(tx, c.id, 'mill'));
    await give(db, c.id, 'wheat', 3, 100);
    const job = await withTx(db, (tx) => startJob(tx, c.id, mill.id, { inputQuality: 3 }));
    expect(job.outputQuality).toBe(3);
  });

  it('restarts a job on collect when inputs are available, and reports when not', async () => {
    const c = await newCompany(db);
    const mill = await withTx(db, (tx) => buyBuilding(tx, c.id, 'mill'));
    await give(db, c.id, 'wheat', 0, 150);
    await withTx(db, (tx) => startJob(tx, c.id, mill.id));
    await finishNow(mill.id);
    const [res] = await withTx(db, (tx) => collect(tx, c.id, { restart: true }));
    expect(res.restarted).toBe(false);
    expect(res.restartError).toMatch(/Needs 100 wheat/);
    expect(await goods(db, c.id, 'flour', 0)).toBe(80);
  });

  it('scales output with level and charges the 1.12^(n−1) upgrade cost', async () => {
    const c = await newCompany(db);
    const mill = await withTx(db, (tx) => buyBuilding(tx, c.id, 'mill'));
    const before = await cash(db, c.id);
    const up = await withTx(db, (tx) => upgradeBuilding(tx, c.id, mill.id));
    expect(up.level).toBe(2);
    expect(up.costCents).toBe(Math.round(40_000_00 * 1.12));
    expect(await cash(db, c.id)).toBe(before - up.costCents);
    await give(db, c.id, 'wheat', 0, 200);
    await withTx(db, (tx) => startJob(tx, c.id, mill.id));
    await finishNow(mill.id);
    const [res] = await withTx(db, (tx) => collect(tx, c.id, { restart: false }));
    expect(res.qty).toBe(160);
  });

  it('enforces building unlock levels', async () => {
    const c = await newCompany(db, { level: 1 });
    await expect(withTx(db, (tx) => buyBuilding(tx, c.id, 'steel_mill'))).rejects.toMatchObject({ code: 'locked' });
  });
});

describe('NPC markets', () => {
  it('pays falling tiers as daily volume grows', () => {
    expect(npcSaleValue(100, 0, 1000)).toBe(100_000);
    expect(npcSaleValue(100, 900, 200)).toBe(100 * 100 + 100 * 90);
    expect(npcSaleValue(100, 10_000, 10)).toBe(700);
  });

  it('buys goods with the quality premium and refuses raw inputs', async () => {
    const c = await newCompany(db, { capital: 0 });
    await give(db, c.id, 'wheat', 2, 100);
    const sale = await withTx(db, (tx) => npcSell(tx, c.id, 'wheat', 100, 2));
    expect(sale.proceedsCents).toBe(Math.round(450 * 1.16 * 100));
    expect(await cash(db, c.id)).toBe(sale.proceedsCents);
    await give(db, c.id, 'seeds', 0, 10);
    await expect(withTx(db, (tx) => npcSell(tx, c.id, 'seeds', 10, 0))).rejects.toMatchObject({ code: 'not_bought' });
  });
});
