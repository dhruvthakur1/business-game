import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resaleValue } from '../../shared/bank';
import { depositSavings, drawCredit, loanOffers, openCreditLine, paySavingsInterest, repayCredit, takeLoan, withdrawSavings } from '../src/bank';
import { closeDay, receivership } from '../src/daily';
import { type Db, withTx } from '../src/db';
import { companyAccount, systemAccount, transfer } from '../src/ledger';
import { npcSell } from '../src/npc';
import { buyBuilding } from '../src/production';
import { gameDay } from '../src/time';
import { cash, freshDb, give, ledgerTotal, newCompany } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

const loan = async (id: string) => (await db.query('SELECT * FROM loans WHERE id = $1', [id])).rows[0];
const savings = async (id: string) => cash(db, id, 'savings' as 'cash');

/** An established company: 40 days old, with recent sales (operating flow and revenue). */
async function established(level: number, capital = 1_000_000_00) {
  const c = await newCompany(db, { capital, level });
  await db.query('UPDATE companies SET created_day = created_day - 40 WHERE id = $1', [c.id]);
  await give(db, c.id, 'bread', 0, 3_000);
  await withTx(db, (tx) => npcSell(tx, c.id, 'bread', 3_000, 0));
  return c;
}

describe('mortgages', () => {
  it('lends up to LTV × resale value of one building, at a discount to the term rate', async () => {
    const c = await established(10);
    const mill = await withTx(db, (tx) => buyBuilding(tx, c.id, 'steel_mill')); // 150k build
    const offers = await loanOffers(db, c.id);
    expect(offers.mortgage.available).toBe(true);
    const b = offers.mortgage.buildings.find((x) => x.id === mill.id)!;
    expect(b.resaleCents).toBe(Math.round(resaleValue(150_000_00, 1)));
    expect(b.maxCents).toBeLessThanOrEqual(Math.round(offers.mortgage.maxLtv * b.resaleCents));
    expect(offers.mortgage.dailyRate).toBeCloseTo(Math.max(0.0005, offers.term.dailyRate - 0.0003));

    await expect(withTx(db, (tx) => takeLoan(tx, c.id, { product: 'mortgage', buildingId: mill.id, principalCents: b.maxCents + 10_000, days: 60 })))
      .rejects.toMatchObject({ code: 'bad_request' });
    const m = await withTx(db, (tx) => takeLoan(tx, c.id, { product: 'mortgage', buildingId: mill.id, principalCents: 20_000_00, days: 60 }));
    expect((await loan(m.loanId)).building_id).toBe(mill.id);
    await expect(withTx(db, (tx) => takeLoan(tx, c.id, { product: 'mortgage', buildingId: mill.id, principalCents: 20_000_00, days: 60 })))
      .rejects.toMatchObject({ code: 'mortgaged' });
  });

  it('unlocks at level 8', async () => {
    const c = await established(7);
    expect((await loanOffers(db, c.id)).mortgage.reason).toMatch(/level 8/);
  });

  it('repays the mortgage from its building first in receivership', async () => {
    const c = await established(10);
    await withTx(db, (tx) => buyBuilding(tx, c.id, 'farm')); // first building: protected
    const mill = await withTx(db, (tx) => buyBuilding(tx, c.id, 'steel_mill'));
    const m = await withTx(db, (tx) => takeLoan(tx, c.id, { product: 'mortgage', buildingId: mill.id, principalCents: 20_000_00, days: 60 }));
    // Empty the company and force the loan into default territory.
    await withTx(db, async (tx) => transfer(tx, 'op_cost', 'test drain', await companyAccount(tx, c.id, 'cash'), await systemAccount(tx, 'sink:operations'), await cash(db, c.id)));
    await db.query("UPDATE loans SET arrears_cents = 1_000_00, days_past_due = 14, status = 'collections' WHERE id = $1", [m.loanId]);
    await withTx(db, (tx) => receivership(tx, c.id, gameDay()));
    const after = await loan(m.loanId);
    expect(after.status).toBe('repaid');
    const events = await db.query("SELECT note FROM loan_events WHERE loan_id = $1 AND kind = 'liquidation'", [m.loanId]);
    expect(events.rows[0].note).toMatch(/Steel Mill sold/);
  });
});

describe('line of credit', () => {
  it('opens at 30% of 7-day revenue, draws within the limit and charges interest only on what is drawn', async () => {
    const c = await established(12);
    const offers = await loanOffers(db, c.id);
    // 3,000 bread to NPCs: 1,000 × 27 + 2,000 × 27 × 0.9 (volume tier) = 75,600 CR → 30% = 22,680 → 22,600 CR.
    expect(offers.creditLine.limitCents).toBe(22_600_00);
    const line = await withTx(db, (tx) => openCreditLine(tx, c.id));
    await expect(withTx(db, (tx) => openCreditLine(tx, c.id))).rejects.toMatchObject({ code: 'open' });

    await expect(withTx(db, (tx) => drawCredit(tx, c.id, 22_600_01))).rejects.toMatchObject({ code: 'over_limit' });
    await withTx(db, (tx) => drawCredit(tx, c.id, 10_000_00));
    const before = await cash(db, c.id);
    await withTx(db, (tx) => closeDay(tx, c.id, gameDay() + 1));
    const l = await loan(line.loanId);
    const interest = Math.round(10_000_00 * Number(l.daily_rate));
    expect(l).toMatchObject({ status: 'active', arrears_cents: 0, outstanding_cents: 10_000_00 });
    expect(before - (await cash(db, c.id))).toBe(interest); // no buildings → no upkeep

    await withTx(db, (tx) => repayCredit(tx, c.id, 4_000_00));
    expect((await loan(line.loanId)).outstanding_cents).toBe(6_000_00);
    // Undrawn lines cost nothing and stay open.
    await withTx(db, (tx) => repayCredit(tx, c.id, 6_000_00));
    await withTx(db, (tx) => closeDay(tx, c.id, gameDay() + 2));
    expect(await loan(line.loanId)).toMatchObject({ status: 'active', outstanding_cents: 0 });
  });

  it('reviews the limit weekly from recent revenue', async () => {
    const c = await established(12);
    const line = await withTx(db, (tx) => openCreditLine(tx, c.id));
    await db.query('UPDATE loans SET limit_reviewed_day = limit_reviewed_day - 7 WHERE id = $1', [line.loanId]);
    await give(db, c.id, 'bread', 0, 3_000);
    await withTx(db, (tx) => npcSell(tx, c.id, 'bread', 3_000, 0));
    await withTx(db, (tx) => closeDay(tx, c.id, gameDay() + 1));
    expect(Number((await loan(line.loanId)).credit_limit_cents)).toBeGreaterThan(22_600_00);
  });
});

describe('savings', () => {
  it('moves cash in and out and pays 0.02%/day on up to 500k CR', async () => {
    const c = await newCompany(db, { capital: 1_000_000_00 });
    await withTx(db, (tx) => depositSavings(tx, c.id, 600_000_00));
    expect(await savings(c.id)).toBe(600_000_00);
    const interest = await withTx(db, (tx) => paySavingsInterest(tx, c.id));
    expect(interest).toBe(100_00); // 0.02% of the 500k cap
    await withTx(db, (tx) => withdrawSavings(tx, c.id, 100_000_00));
    expect(await savings(c.id)).toBe(500_100_00);
    await expect(withTx(db, (tx) => withdrawSavings(tx, c.id, 600_000_00))).rejects.toMatchObject({ code: 'insufficient_funds' });
    const totals = await ledgerTotal(db);
    expect(totals.balances).toBe(0);
    expect(totals.entries).toBe(0);
  });
});
