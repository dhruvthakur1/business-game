import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seasonTier, tierReward, XP_PER_TIER } from '../../shared/season';
import { type Db, withTx } from '../src/db';
import { claimAll, claimTier, seasonAt, seasonSummary, seasonView, setTitle } from '../src/season';
import { walletCents } from '../src/wealth';
import { awardXp } from '../src/xp';
import { freshDb, goods, ledgerTotal, newCompany } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

const earn = (companyId: string, xp: number) => withTx(db, (tx) => awardXp(tx, companyId, 'production', xp, { note: 'test' }));

describe('season rules', () => {
  it('maps XP to tiers and gives every tier a reward', () => {
    expect(seasonTier(XP_PER_TIER - 1)).toBe(0);
    expect(seasonTier(XP_PER_TIER * 3)).toBe(3);
    expect(seasonTier(1e9)).toBe(40);
    expect(tierReward(1, 1)).toEqual({ kind: 'wallet', amount: 250 });
    expect(tierReward(1, 2)).toEqual({ kind: 'research', amount: 25 });
    expect(tierReward(1, 5).kind).toBe('livery');
    expect(tierReward(1, 10)).toEqual({ kind: 'title', name: 'Apprentice Merchant · S1' });
    expect(tierReward(3, 40)).toEqual({ kind: 'trophy', name: 'Electric Age Tycoon' });
  });

  it('runs 28-day seasons', async () => {
    const s = await seasonAt(db, 280);
    expect(s).toMatchObject({ startDay: 280, endDay: 308, daysLeft: 28 });
  });
});

describe('claiming', () => {
  it('claims reached tiers once, granting wallet cash, research points and cosmetics', async () => {
    const c = await newCompany(db);
    await earn(c.id, XP_PER_TIER * 10);
    expect((await seasonSummary(db, c.id)).unclaimed).toBe(10);
    await expect(withTx(db, (tx) => claimTier(tx, c.id, 11))).rejects.toMatchObject({ code: 'not_reached' });

    await withTx(db, (tx) => claimTier(tx, c.id, 1));
    expect(await walletCents(db, c.id)).toBe(25_000);
    await expect(withTx(db, (tx) => claimTier(tx, c.id, 1))).rejects.toMatchObject({ code: 'claimed' });

    const all = await withTx(db, (tx) => claimAll(tx, c.id));
    expect(all.claimed.map((x) => x.tier)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Wallet: tiers 1,3,5→livery,7,9 → 250 × 4 = 1,000 CR. Research: tiers 2,4,6,8 → 100 RP.
    expect(await walletCents(db, c.id)).toBe(100_000);
    expect(await goods(db, c.id, 'research_points', 0)).toBe(100);
    const view = await seasonView(db, c.id);
    expect(view.unclaimed).toBe(0);
    expect(view.cosmetics.map((x) => x.kind).sort()).toEqual(['livery', 'title']);
  });

  it('equips only unlocked titles', async () => {
    const c = await newCompany(db);
    await expect(withTx(db, (tx) => setTitle(tx, c.id, 'Apprentice Merchant · S1'))).rejects.toMatchObject({ code: 'not_found' });
    await earn(c.id, XP_PER_TIER * 10);
    const s = await seasonAt(db);
    await withTx(db, (tx) => claimTier(tx, c.id, 10));
    const name = (tierReward(s.number, 10) as { name: string }).name;
    await withTx(db, (tx) => setTitle(tx, c.id, name));
    expect((await seasonSummary(db, c.id)).title).toBe(name);
  });

  it('awards a season trophy at tier 40 and keeps the ledger balanced', async () => {
    const c = await newCompany(db);
    await earn(c.id, XP_PER_TIER * 40);
    await withTx(db, (tx) => claimTier(tx, c.id, 40));
    const t = await db.query<{ kind: string; title: string }>('SELECT kind, title FROM trophies WHERE company_id = $1', [c.id]);
    expect(t.rows[0].kind).toBe('season');
    const totals = await ledgerTotal(db);
    expect(totals.balances).toBe(0);
    expect(totals.entries).toBe(0);
  });
});
