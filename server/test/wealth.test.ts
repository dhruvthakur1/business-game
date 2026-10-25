import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prestigeScore, itemById } from '../../shared/wealth';
import { type Db, withTx } from '../src/db';
import { npcSell } from '../src/npc';
import { assetsCents } from '../src/state';
import { gameDay } from '../src/time';
import {
  buyItem, cashflowHistory, closeOwnerDay, declareDividend, ownerWithdrawal, payoutLimits, payoutTax, sellItem, setSalary, walletCents,
} from '../src/wealth';
import { buyBuilding } from '../src/production';
import { cash, freshDb, give, ledgerTotal, newCompany } from './helpers';
import { companyAccount, systemAccount, transfer } from '../src/ledger';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

/** Records `cr` of operating profit per day for the last `days` game days. */
async function history(companyId: string, cr: number, days: number) {
  const today = gameDay();
  for (let d = today - days + 1; d <= today; d++) {
    await db.query(
      'INSERT INTO company_days (company_id, day, operating_flow_cents, upkeep_cents, debt_service_cents, cash_cents) VALUES ($1, $2, $3, 0, 0, 0)',
      [companyId, d, cr * 100],
    );
  }
}

const fundWallet = (companyId: string, cr: number) =>
  withTx(db, async (tx) => transfer(tx, 'starting_capital', 'test', await systemAccount(tx, 'faucet:starting_capital'), await companyAccount(tx, companyId, 'wallet'), cr * 100));

describe('income tax on payouts', () => {
  it('taxes only the part of a payout above each band', () => {
    // 50k CR tax-free, then 10%: a 60k payout from nothing owes 1,000 CR.
    expect(payoutTax(0, 6_000_000, 'dividend')).toBe(100_000);
    // Already 40k paid out this month: a further 20k has 10k in the 10% band.
    expect(payoutTax(4_000_000, 2_000_000, 'salary')).toBe(100_000);
    // Withdrawals add 10% on top.
    expect(payoutTax(0, 1_000_000, 'withdrawal')).toBe(100_000);
  });
});

describe('paying the owner', () => {
  it('caps salary at 15% of the 7-day average operating profit and pays it at the daily close', async () => {
    const c = await newCompany(db);
    await history(c.id, 10_000, 7);
    await expect(withTx(db, (tx) => setSalary(tx, c.id, 150_001))).rejects.toMatchObject({ code: 'salary_cap' });
    await withTx(db, (tx) => setSalary(tx, c.id, 150_000));
    const before = await cash(db, c.id);
    const res = await withTx(db, (tx) => closeOwnerDay(tx, c.id, gameDay()));
    expect(res.salaryPaid).toBe(150_000);
    expect(before - (await cash(db, c.id))).toBe(150_000);
    expect(await walletCents(db, c.id)).toBe(150_000); // under the tax-free allowance
  });

  it('limits dividends to recent profit not yet paid out, and keeps a cash reserve', async () => {
    const c = await newCompany(db, { capital: 100_000_00 });
    await history(c.id, 2_000, 10); // 20k CR profit over 30 days
    const limits = await payoutLimits(db, c.id);
    expect(limits.dividendAvailableCents).toBe(2_000_000);
    await withTx(db, (tx) => declareDividend(tx, c.id, 1_500_000));
    await expect(withTx(db, (tx) => declareDividend(tx, c.id, 600_000))).rejects.toMatchObject({ code: 'dividend_limit' });

    // Withdrawals ignore profit but must leave 7 days of upkeep in cash.
    await withTx(db, (tx) => buyBuilding(tx, c.id, 'farm')); // 30k build, 100 CR/day upkeep
    const after = await payoutLimits(db, c.id);
    expect(after.reserveCents).toBe(7 * 10_000);
    expect(after.withdrawableCents).toBe(after.cashCents - 70_000);
    await expect(withTx(db, (tx) => ownerWithdrawal(tx, c.id, after.withdrawableCents + 1))).rejects.toMatchObject({ code: 'withdrawal_limit' });
    const w = await withTx(db, (tx) => ownerWithdrawal(tx, c.id, 1_000_000));
    // 15k dividend already this month → 10k more stays under 50k, so only the 10% withdrawal tax applies.
    expect(w.taxCents).toBe(100_000);
  });

  it('blocks payouts while upkeep is unpaid', async () => {
    const c = await newCompany(db);
    await history(c.id, 5_000, 7);
    await db.query('UPDATE companies SET upkeep_arrears_cents = 100 WHERE id = $1', [c.id]);
    await expect(withTx(db, (tx) => declareDividend(tx, c.id, 100))).rejects.toMatchObject({ code: 'delinquent' });
  });
});

describe('luxury items', () => {
  it('buys rungs in order from the wallet and sells back at the buyback rate', async () => {
    const c = await newCompany(db);
    await fundWallet(c.id, 10_000);
    await expect(withTx(db, (tx) => buyItem(tx, c.id, 'watch_automatic'))).rejects.toMatchObject({ code: 'ladder' });
    await withTx(db, (tx) => buyItem(tx, c.id, 'watch_quartz'));
    await expect(withTx(db, (tx) => buyItem(tx, c.id, 'watch_automatic'))).rejects.toMatchObject({ code: 'insufficient_funds' });
    await expect(withTx(db, (tx) => buyItem(tx, c.id, 'watch_founders'))).rejects.toMatchObject({ code: 'auction_only' });
    // Homes: the starter studio is free, so the apartment is the first rung to buy.
    await expect(withTx(db, (tx) => buyItem(tx, c.id, 'home_apartment'))).rejects.toMatchObject({ code: 'insufficient_funds' });

    const sold = await withTx(db, (tx) => sellItem(tx, c.id, 'watch_quartz'));
    expect(sold.proceedsCents).toBe(105_000);
    expect(await walletCents(db, c.id)).toBe(1_000_000 - 150_000 + 105_000);
  });

  it('stores an item when its upkeep cannot be paid, and brings it back when it can', async () => {
    const c = await newCompany(db);
    await fundWallet(c.id, 2_500);
    await withTx(db, (tx) => buyItem(tx, c.id, 'car_economy')); // 0.50 CR/day upkeep, wallet now 0
    await withTx(db, (tx) => closeOwnerDay(tx, c.id, gameDay()));
    const stored = await db.query<{ stored: boolean }>('SELECT stored FROM personal_items WHERE company_id = $1', [c.id]);
    expect(stored.rows[0].stored).toBe(true);
    await fundWallet(c.id, 1);
    await withTx(db, (tx) => closeOwnerDay(tx, c.id, gameDay()));
    const back = await db.query<{ stored: boolean }>('SELECT stored FROM personal_items WHERE company_id = $1', [c.id]);
    expect(back.rows[0].stored).toBe(false);
    expect(await walletCents(db, c.id)).toBe(50);
  });

  it('scores prestige on a log scale with rarity and trophies', () => {
    expect(prestigeScore([itemById('car_economy')!], 0)).toBe(40);
    expect(prestigeScore([itemById('car_supercar')!], 2)).toBe(Math.round(100 * Math.log10(2500) * 1.5 + 200));
  });

  it('keeps the wallet out of company net worth and the ledger balanced', async () => {
    const c = await newCompany(db);
    const before = await assetsCents(db, c.id);
    await fundWallet(c.id, 5_000);
    expect(await assetsCents(db, c.id)).toBe(before);
    const totals = await ledgerTotal(db);
    expect(totals.balances).toBe(0);
    expect(totals.entries).toBe(0);
  });
});

describe('cash-flow history', () => {
  it('returns seven days with today’s sales as revenue', async () => {
    const c = await newCompany(db);
    await give(db, c.id, 'bread', 0, 10);
    await withTx(db, (tx) => npcSell(tx, c.id, 'bread', 10, 0));
    const days = await cashflowHistory(db, c.id, 7);
    expect(days).toHaveLength(7);
    expect(days[6]).toMatchObject({ day: gameDay(), revenueCents: 27_000, costsCents: 0 });
  });
});
