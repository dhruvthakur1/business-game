import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { levelForXp, levelProgress, nextUnlock, XP_CAPS, xpForLevel } from '../../shared/levels';
import { offerContract } from '../src/contracts';
import { type Db, withTx } from '../src/db';
import { placeOrder } from '../src/exchange';
import { npcBuy, npcSell } from '../src/npc';
import { buyBuilding, collect, startJob } from '../src/production';
import { awardXp } from '../src/xp';
import { freshDb, give, newCompany } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

const company = async (id: string) => (await db.query<{ xp: number; level: number }>('SELECT xp, level FROM companies WHERE id = $1', [id])).rows[0];
const finishNow = (buildingId: string) =>
  db.query("UPDATE production_jobs SET finishes_at = now() - interval '1 second' WHERE building_id = $1 AND state = 'running'", [buildingId]);

describe('level curve', () => {
  it('needs 1,000 XP for Lv 2 and 25% more per level after', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(1000);
    expect(xpForLevel(3)).toBe(2250);
    expect(xpForLevel(4) - xpForLevel(3)).toBe(1563);
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(999)).toBe(1);
    expect(levelForXp(1000)).toBe(2);
    expect(levelForXp(xpForLevel(12) + 5)).toBe(12);
  });

  it('reports progress inside the level and the next unlock', () => {
    expect(levelProgress(1500, 2)).toEqual({ intoLevel: 500, levelSize: 1250, nextLevelAt: 2250 });
    expect(nextUnlock(1)).toEqual({ level: 2, names: ['Starter loan'] });
    expect(nextUnlock(2)?.level).toBe(3);
    expect(nextUnlock(4)).toEqual({ level: 5, names: ['Iron Mine', 'Thermal Power', 'Supply contracts & RFQs', 'Term loans'] });
  });
});

describe('XP awards', () => {
  it('awards production XP for value added at base prices', async () => {
    const c = await newCompany(db, { level: 1 });
    const farm = await withTx(db, (tx) => buyBuilding(tx, c.id, 'farm'));
    await withTx(db, (tx) => npcBuy(tx, c.id, 'seeds', 60));
    await withTx(db, (tx) => npcBuy(tx, c.id, 'fertilizer', 20));
    await withTx(db, (tx) => startJob(tx, c.id, farm.id));
    await finishNow(farm.id);
    const [res] = await withTx(db, (tx) => collect(tx, c.id, { restart: false }));
    // 100 wheat × 4.50 − (60 × 1.20 + 20 × 4.00) = 298 CR → × 0.2 = 59 XP
    expect(res.xp).toBe(59);
    expect((await company(c.id)).xp).toBe(59);
  });

  it('levels up when crossing a threshold, and never goes down', async () => {
    const c = await newCompany(db, { level: 1 });
    const a = await withTx(db, (tx) => awardXp(tx, c.id, 'production', 999));
    expect(a).toEqual({ awarded: 999, levelBefore: 1, levelAfter: 1 });
    const b = await withTx(db, (tx) => awardXp(tx, c.id, 'production', 1300));
    expect(b.levelAfter).toBe(3);
    expect(await company(c.id)).toEqual({ xp: 2299, level: 3 });
  });

  it('caps market XP per game day across trades and NPC sales', async () => {
    const seller = await newCompany(db, { level: 1, capital: 0 });
    const buyer = await newCompany(db, { level: 1, capital: 10_000_000_00 });
    await give(db, seller.id, 'steel', 0, 20_000);
    await withTx(db, (tx) => placeOrder(tx, seller.id, { productId: 'steel', side: 'sell', qty: 10_000, priceCents: 2400, quality: 0 }));
    await withTx(db, (tx) => placeOrder(tx, buyer.id, { productId: 'steel', side: 'buy', qty: 10_000, priceCents: 2400, quality: 0 }));
    // 240,000 CR traded → 2,400 XP each side, capped at 400.
    expect((await company(seller.id)).xp).toBe(XP_CAPS.market);
    expect((await company(buyer.id)).xp).toBe(XP_CAPS.market);
    await withTx(db, (tx) => npcSell(tx, seller.id, 'steel', 1000, 0));
    expect((await company(seller.id)).xp).toBe(XP_CAPS.market);
  });

  it('gives NPC companies no XP', async () => {
    const { createCompany } = await import('../src/companies');
    const { company: npc } = await createCompany(db, { name: `XP NPC ${Date.now() % 10000}`, isNpc: true, level: 30, capitalCents: 0 });
    const before = await company(npc.id);
    const r = await withTx(db, (tx) => awardXp(tx, npc.id, 'trade', 100));
    expect(r.awarded).toBe(0);
    expect(await company(npc.id)).toEqual(before);
  });
});

describe('unlock gates', () => {
  it('locks contracts below level 5', async () => {
    const low = await newCompany(db, { level: 4 });
    const other = await newCompany(db);
    await expect(
      withTx(db, (tx) =>
        offerContract(tx, low.id, {
          counterpartyId: other.id, role: 'buy',
          terms: { productId: 'flour', qty: 10, minQuality: 0, priceCents: 800, frequencyHours: 24, windowHours: 24, termDays: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'locked' });
  });

  it('locks higher-tier buildings until their level', async () => {
    const c = await newCompany(db, { level: 4 });
    await expect(withTx(db, (tx) => buyBuilding(tx, c.id, 'iron_mine'))).rejects.toMatchObject({ code: 'locked' });
    await withTx(db, (tx) => awardXp(tx, c.id, 'production', xpForLevel(5) - xpForLevel(4)));
    expect((await company(c.id)).level).toBe(5);
    await expect(withTx(db, (tx) => buyBuilding(tx, c.id, 'iron_mine'))).resolves.toMatchObject({ name: 'Iron Mine' });
  });
});
