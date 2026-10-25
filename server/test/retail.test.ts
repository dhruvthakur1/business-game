import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bestSupermarketMarkup, supermarketBand, supermarketUnits } from '../../shared/retail';
import { type Db, withTx } from '../src/db';
import { companyAccount, systemAccount, transfer } from '../src/ledger';
import { buyBuilding, collect, startJob } from '../src/production';
import { buyFromStore, createListing, setShelf, withdrawListing } from '../src/retail';
import { sellItem, walletCents, wealthView } from '../src/wealth';
import { cash, freshDb, give, goods, ledgerTotal, newCompany } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

const finishNow = (buildingId: string) =>
  db.query("UPDATE production_jobs SET finishes_at = now() - interval '1 second' WHERE building_id = $1 AND state = 'running'", [buildingId]);
const fundWallet = (companyId: string, cr: number) =>
  withTx(db, async (tx) => transfer(tx, 'starting_capital', 'test', await systemAccount(tx, 'faucet:starting_capital'), await companyAccount(tx, companyId, 'wallet'), cr * 100));

describe('supermarket rules', () => {
  it('prices from the quality-adjusted reference up to +35%', () => {
    expect(supermarketBand(2700, 1)).toEqual({ minCents: 2916, maxCents: 3936 });
  });

  it('sells fewer units as the markup rises, more with quality', () => {
    expect(supermarketUnits(60, 100, 2916, 2916, 1)).toBe(60); // no markup: full shelf
    expect(supermarketUnits(60, 100, 3936, 2916, 0)).toBe(39); // +35% at Q0: 65%
    expect(supermarketUnits(60, 100, 3936, 2916, 3)).toBe(50); // +35% at Q3: 65% × 1.3 = 84.5%
    expect(supermarketUnits(60, 20, 2916, 2916, 1)).toBe(20); // never more than stocked
    expect(bestSupermarketMarkup(2)).toBeCloseTo(1 / 6);
  });
});

describe('supermarket shelves', () => {
  it('stocks the shelf each cycle, sells to shoppers and returns what is left', async () => {
    const c = await newCompany(db);
    const market = await withTx(db, (tx) => buyBuilding(tx, c.id, 'supermarket'));
    await expect(withTx(db, (tx) => startJob(tx, c.id, market.id))).rejects.toMatchObject({ code: 'no_shelf' });
    await expect(withTx(db, (tx) => setShelf(tx, c.id, market.id, { productId: 'steel', quality: 0, priceCents: 2500 }))).rejects.toMatchObject({ code: 'not_food' });
    await expect(withTx(db, (tx) => setShelf(tx, c.id, market.id, { productId: 'bread', quality: 1, priceCents: 4000 }))).rejects.toMatchObject({ code: 'price_band' });
    await withTx(db, (tx) => setShelf(tx, c.id, market.id, { productId: 'bread', quality: 1, priceCents: 3936 }));

    await give(db, c.id, 'bread', 1, 100);
    const started = await withTx(db, (tx) => startJob(tx, c.id, market.id));
    expect(started).toMatchObject({ stocked: 60, priceCents: 3936 });
    expect(await goods(db, c.id, 'bread', 1)).toBe(40);

    await finishNow(market.id);
    const before = await cash(db, c.id);
    const [res] = await withTx(db, (tx) => collect(tx, c.id, { restart: false }));
    // +35% at Q1: 65% × 1.1 = 71.5% of 60 → 42 sold, 18 back on the shelf's lot.
    expect(res.retail).toEqual({ sold: 42, unsold: 18, proceedsCents: 42 * 3936 });
    expect((await cash(db, c.id)) - before).toBe(42 * 3936);
    expect(await goods(db, c.id, 'bread', 1)).toBe(58);
    const job = await db.query<{ value_add_cents: number }>("SELECT value_add_cents FROM production_jobs WHERE building_id = $1 AND state = 'collected'", [market.id]);
    expect(Number(job.rows[0].value_add_cents)).toBe(42 * (3936 - 2700));
  });

  it('restarts with fresh stock on collect', async () => {
    const c = await newCompany(db);
    const market = await withTx(db, (tx) => buyBuilding(tx, c.id, 'supermarket'));
    await withTx(db, (tx) => setShelf(tx, c.id, market.id, { productId: 'bread', quality: 0, priceCents: 2700 }));
    await give(db, c.id, 'bread', 0, 70);
    await withTx(db, (tx) => startJob(tx, c.id, market.id));
    await finishNow(market.id);
    const [res] = await withTx(db, (tx) => collect(tx, c.id, { restart: true }));
    expect(res.retail?.sold).toBe(60);
    expect(res.restarted).toBe(true);
    expect(await goods(db, c.id, 'bread', 0)).toBe(0); // 10 left, all restocked
  });
});

describe('luxury stores', () => {
  it('lists T7 goods within 1.2×–3× wholesale, up to 20 units per level', async () => {
    const s = await newCompany(db, { capital: 50_000_000 });
    const store = await withTx(db, (tx) => buyBuilding(tx, s.id, 'luxury_store'));
    await give(db, s.id, 'luxury_watch', 2, 30);
    await give(db, s.id, 'bread', 0, 5);
    await expect(withTx(db, (tx) => createListing(tx, s.id, store.id, { productId: 'bread', quality: 0, qty: 5, priceCents: 4000 }))).rejects.toMatchObject({ code: 'not_luxury' });
    await expect(withTx(db, (tx) => createListing(tx, s.id, store.id, { productId: 'luxury_watch', quality: 2, qty: 1, priceCents: 100_000 }))).rejects.toMatchObject({ code: 'price_band' });
    await expect(withTx(db, (tx) => createListing(tx, s.id, store.id, { productId: 'luxury_watch', quality: 2, qty: 21, priceCents: 150_000 }))).rejects.toMatchObject({ code: 'store_full' });
    const l = await withTx(db, (tx) => createListing(tx, s.id, store.id, { productId: 'luxury_watch', quality: 2, qty: 5, priceCents: 150_000 }));
    expect(await goods(db, s.id, 'luxury_watch', 2)).toBe(25);
    await withTx(db, (tx) => withdrawListing(tx, s.id, l.listingId));
    expect(await goods(db, s.id, 'luxury_watch', 2)).toBe(30);
  });

  it('sells to another player’s wallet, adds the piece to their collection, and pays the store minus 2%', async () => {
    const s = await newCompany(db, { capital: 50_000_000 });
    const buyer = await newCompany(db);
    const store = await withTx(db, (tx) => buyBuilding(tx, s.id, 'luxury_store'));
    await give(db, s.id, 'luxury_watch', 1, 3);
    const l = await withTx(db, (tx) => createListing(tx, s.id, store.id, { productId: 'luxury_watch', quality: 1, qty: 3, priceCents: 200_000 }));

    await expect(withTx(db, (tx) => buyFromStore(tx, s.id, l.listingId))).rejects.toMatchObject({ code: 'own_store' });
    await expect(withTx(db, (tx) => buyFromStore(tx, buyer.id, l.listingId))).rejects.toMatchObject({ code: 'insufficient_funds' });
    await fundWallet(buyer.id, 5_000);
    const sellerBefore = await cash(db, s.id);
    await withTx(db, (tx) => buyFromStore(tx, buyer.id, l.listingId));
    expect((await cash(db, s.id)) - sellerBefore).toBe(196_000);
    expect(await walletCents(db, buyer.id)).toBe(300_000);
    await expect(withTx(db, (tx) => buyFromStore(tx, buyer.id, l.listingId))).rejects.toMatchObject({ code: 'owned' });

    const view = await wealthView(db, buyer.id);
    expect(view.owned.find((o) => o.productId === 'luxury_watch')).toMatchObject({ quality: 1, priceCents: 200_000 });
    // 100 × log10(2,000 / 1,000) ≈ 30 prestige for one watch.
    expect(view.prestige).toBe(30);

    const sold = await withTx(db, (tx) => sellItem(tx, buyer.id, 'product:luxury_watch'));
    expect(sold.proceedsCents).toBe(140_000);

    const totals = await ledgerTotal(db);
    expect(totals.balances).toBe(0);
    expect(totals.entries).toBe(0);
  });
});
