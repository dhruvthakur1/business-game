import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_LOAN } from '../../shared/bank';
import { emi } from '../../shared/economy';
import { creditProfile, loanOffers, repayLoan, restructureLoan, takeLoan } from '../src/bank';
import { closeDay, runDueClosures } from '../src/daily';
import { type Db, withTx } from '../src/db';
import { companyAccount, systemAccount, transfer } from '../src/ledger';
import { npcSell } from '../src/npc';
import { buyBuilding, startJob } from '../src/production';
import { gameDay } from '../src/time';
import { cash, freshDb, give, ledgerTotal, newCompany } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

const today = () => gameDay();
const close = (companyId: string, day: number) => withTx(db, (tx) => closeDay(tx, companyId, day));
const loan = async (id: string) => (await db.query('SELECT * FROM loans WHERE id = $1', [id])).rows[0];
const company = async (id: string) => (await db.query('SELECT * FROM companies WHERE id = $1', [id])).rows[0];
const sysBalance = async (kind: string) => (await db.query<{ b: number }>('SELECT balance_cents AS b FROM accounts WHERE company_id IS NULL AND kind = $1', [kind])).rows[0]?.b ?? 0;

/** Moves all of a company's cash into a sink, simulating a cash crunch. */
async function drain(companyId: string, leave = 0) {
  const balance = await cash(db, companyId);
  if (balance <= leave) return;
  await withTx(db, async (tx) => transfer(tx, 'op_cost', 'test drain', await companyAccount(tx, companyId, 'cash'), await systemAccount(tx, 'sink:operations'), balance - leave));
}

describe('upkeep and overdraft', () => {
  it('charges level-scaled upkeep at the daily close', async () => {
    const c = await newCompany(db, { capital: 100_000_00 });
    const farm = await withTx(db, (tx) => buyBuilding(tx, c.id, 'farm'));
    await db.query('UPDATE buildings SET level = 3 WHERE id = $1', [farm.id]);
    const before = await cash(db, c.id);
    const report = await close(c.id, today());
    expect(report.upkeepPaidCents).toBe(300_00);
    expect(await cash(db, c.id)).toBe(before - 300_00);
    const snap = await db.query('SELECT * FROM company_days WHERE company_id = $1', [c.id]);
    expect(snap.rows[0]).toMatchObject({ day: today(), upkeep_cents: 300_00 });
  });

  it('draws the overdraft when cash runs short, then repays it automatically', async () => {
    const c = await newCompany(db, { capital: 100_000_00 });
    await withTx(db, (tx) => buyBuilding(tx, c.id, 'farm'));
    await drain(c.id, 40_00);
    const r1 = await close(c.id, today());
    expect(r1.overdraftDrawCents).toBe(60_00);
    expect(r1.upkeepShortCents).toBe(0);
    const od = (await db.query("SELECT * FROM loans WHERE company_id = $1 AND product = 'overdraft'", [c.id])).rows[0];
    expect(od).toMatchObject({ outstanding_cents: 60_00, arrears_cents: 50_00, status: 'active' });

    await withTx(db, async (tx) => transfer(tx, 'npc_sale', 'test income', await systemAccount(tx, 'npc:buyer'), await companyAccount(tx, c.id, 'cash'), 1_000_00));
    await close(c.id, today() + 1);
    const after = await loan(od.id);
    expect(after.status).toBe('repaid');
    // 1,000 in − 100 upkeep − 60 principal − 50 fee − 0.30 interest
    expect(await cash(db, c.id)).toBe(1_000_00 - 100_00 - 60_00 - 50_00 - 30);
  });

  it('records unpaid upkeep beyond the overdraft limit and pauses production', async () => {
    const c = await newCompany(db, { capital: 100_000_00 });
    const farm = await withTx(db, (tx) => buyBuilding(tx, c.id, 'farm'));
    await db.query('UPDATE buildings SET level = 60 WHERE id = $1', [farm.id]); // 6,000 CR/day upkeep
    await drain(c.id);
    const r = await close(c.id, today());
    expect(r.overdraftDrawCents).toBe(5_000_00);
    expect(r.upkeepShortCents).toBe(1_000_00);
    expect((await company(c.id)).upkeep_arrears_cents).toBe(1_000_00);
    await give(db, c.id, 'seeds', 0, 10_000);
    await give(db, c.id, 'fertilizer', 0, 10_000);
    await expect(withTx(db, (tx) => startJob(tx, c.id, farm.id))).rejects.toMatchObject({ code: 'upkeep_arrears' });
  });
});

describe('loans', () => {
  it('pays out the starter loan once and amortizes it over 14 daily installments', async () => {
    // 1,000 CR of own cash on top of the loan covers the interest.
    const c = await newCompany(db, { capital: 1_000_00, level: 2 });
    const bankBefore = await sysBalance('npc:bank');
    const interestBefore = await sysBalance('sink:interest');
    const res = await withTx(db, (tx) => takeLoan(tx, c.id, { product: 'starter' }));
    expect(res.principalCents).toBe(20_000_00);
    expect(res.installmentCents).toBe(Math.round(emi(20_000_00, STARTER_LOAN.dailyRate, 14)));
    expect(await cash(db, c.id)).toBe(21_000_00);
    await expect(withTx(db, (tx) => takeLoan(tx, c.id, { product: 'starter' }))).rejects.toMatchObject({ code: 'not_eligible' });

    // Same day as the loan: nothing due yet.
    expect((await close(c.id, today())).installmentsPaidCents).toBe(0);
    let paid = 0;
    for (let d = 1; d <= 14; d++) paid += (await close(c.id, today() + d)).installmentsPaidCents;

    const l = await loan(res.loanId);
    expect(l).toMatchObject({ status: 'repaid', outstanding_cents: 0, arrears_cents: 0, installments_paid: 14 });
    expect(await cash(db, c.id)).toBe(21_000_00 - paid);
    // Principal went back to the bank; only interest was destroyed.
    expect(await sysBalance('npc:bank')).toBe(bankBefore);
    expect((await sysBalance('sink:interest')) - interestBefore).toBe(paid - 20_000_00);
    expect(paid - 20_000_00).toBeGreaterThan(0);
    expect((await ledgerTotal(db)).balances).toBe(0);
  });

  it('allows early repayment without penalty', async () => {
    const c = await newCompany(db, { capital: 30_000_00, level: 2 });
    const res = await withTx(db, (tx) => takeLoan(tx, c.id, { product: 'starter' }));
    await close(c.id, today() + 1);
    const before = await loan(res.loanId);
    expect(before.installments_paid).toBe(1);
    const cashBefore = await cash(db, c.id);
    const out = await withTx(db, (tx) => repayLoan(tx, c.id, res.loanId));
    // Only the remaining principal is due: no further interest, no penalty.
    expect(out.paidCents).toBe(before.outstanding_cents);
    expect(await cash(db, c.id)).toBe(cashBefore - before.outstanding_cents);
    expect((await loan(res.loanId)).status).toBe('repaid');
  });

  it('walks the delinquency ladder: late fee, score penalty, restructuring offer', async () => {
    const c = await newCompany(db, { capital: 0, level: 2 });
    const res = await withTx(db, (tx) => takeLoan(tx, c.id, { product: 'starter' }));
    await drain(c.id);
    const scoreBefore = (await creditProfile(db, c.id)).score;

    const r1 = await close(c.id, today() + 1);
    expect(r1.missed).toBe(1);
    let l = await loan(res.loanId);
    expect(l).toMatchObject({ status: 'late', days_past_due: 1 });
    expect(l.arrears_cents).toBe(res.installmentCents + Math.round(res.installmentCents * 0.02));
    expect((await company(c.id)).credit_penalty).toBe(15);
    expect((await creditProfile(db, c.id)).score).toBeLessThan(scoreBefore);

    await close(c.id, today() + 2);
    await close(c.id, today() + 3);
    l = await loan(res.loanId);
    expect(l).toMatchObject({ status: 'restructure_offered', days_past_due: 3 });

    const r = await withTx(db, (tx) => restructureLoan(tx, c.id, res.loanId));
    l = await loan(res.loanId);
    expect(l).toMatchObject({ status: 'active', restructured: true, days_past_due: 0, arrears_cents: 0 });
    expect(r.termDays).toBe((14 - 3) * 2);
    expect(Number(l.daily_rate)).toBeCloseTo(0.0015, 6);
    const co = await company(c.id);
    expect(co.credit_penalty).toBe(45 + 30);
    expect(co.borrow_blocked_until).toBe(today() + 14);
    await expect(withTx(db, (tx) => restructureLoan(tx, c.id, res.loanId))).rejects.toMatchObject({ code: 'no_offer' });
  });

  it('goes to collections at 7 days and receivership at 14, protecting the first building', async () => {
    const c = await newCompany(db, { capital: 200_000_00, level: 5 });
    const farm = await withTx(db, (tx) => buyBuilding(tx, c.id, 'farm'));
    const mill = await withTx(db, (tx) => buyBuilding(tx, c.id, 'mill'));
    await withTx(db, (tx) => takeLoan(tx, c.id, { product: 'starter' }));
    await drain(c.id);
    await give(db, c.id, 'bread', 1, 2000); // 2,000 × 27 × 0.8 = 43,200 CR when liquidated

    for (let d = 1; d <= 7; d++) await close(c.id, today() + d);
    expect((await db.query("SELECT status FROM loans WHERE company_id = $1 AND product = 'starter'", [c.id])).rows[0].status).toBe('collections');

    let report;
    for (let d = 8; d <= 14; d++) report = await close(c.id, today() + d);
    expect(report!.receivership).toBe(true);
    expect(report!.bankrupt).toBe(false);
    const starter = (await db.query("SELECT status FROM loans WHERE company_id = $1 AND product = 'starter'", [c.id])).rows[0];
    expect(starter.status).toBe('repaid');
    const left = (await db.query('SELECT id FROM buildings WHERE company_id = $1', [c.id])).rows.map((r) => r.id);
    expect(left).toEqual(expect.arrayContaining([farm.id, mill.id])); // inventory alone covered the debt
    expect((await company(c.id)).borrow_blocked_until).toBe(today() + 14 + 14);
  });

  it('restarts a company that cannot cover its debts (bankruptcy)', async () => {
    const c = await newCompany(db, { capital: 100_000_00, level: 5 });
    const farm = await withTx(db, (tx) => buyBuilding(tx, c.id, 'farm'));
    await withTx(db, (tx) => buyBuilding(tx, c.id, 'mill'));
    await withTx(db, (tx) => takeLoan(tx, c.id, { product: 'starter' }));
    await drain(c.id);
    await give(db, c.id, 'wheat', 0, 100);

    let report;
    for (let d = 1; d <= 14; d++) report = await close(c.id, today() + d);
    expect(report!.bankrupt).toBe(true);
    const left = (await db.query('SELECT id FROM buildings WHERE company_id = $1', [c.id])).rows.map((r) => r.id);
    expect(left).toEqual([farm.id]);
    expect((await db.query("SELECT status FROM loans WHERE company_id = $1 AND product = 'starter'", [c.id])).rows[0].status).toBe('defaulted');
    expect(await cash(db, c.id)).toBeGreaterThanOrEqual(50_000_00);
    const co = await company(c.id);
    expect(co.bankruptcies).toBe(1);
    expect((await creditProfile(db, c.id)).score).toBe(450);
    expect((await ledgerTotal(db)).balances).toBe(0);
  });
});

describe('term loans and credit score', () => {
  it('requires age, level and operating cash flow, and caps the amount', async () => {
    const c = await newCompany(db, { capital: 0, level: 30 });
    const offers = await loanOffers(db, c.id);
    expect(offers.term.available).toBe(false);
    expect(offers.term.reason).toMatch(/game days old/);

    await db.query('UPDATE companies SET created_day = created_day - 40 WHERE id = $1', [c.id]);
    await give(db, c.id, 'wheat', 0, 10_000);
    await withTx(db, (tx) => npcSell(tx, c.id, 'wheat', 10_000, 0));
    const ready = await loanOffers(db, c.id);
    expect(ready.term.available).toBe(true);
    expect(ready.term.maxCents).toBeGreaterThan(0);

    await expect(withTx(db, (tx) => takeLoan(tx, c.id, { product: 'term', principalCents: ready.term.maxCents + 10_000, days: 30 }))).rejects.toMatchObject({ code: 'bad_request' });
    await expect(withTx(db, (tx) => takeLoan(tx, c.id, { product: 'term', principalCents: 10_000_00, days: 31 }))).rejects.toMatchObject({ code: 'bad_request' });
    const ok = await withTx(db, (tx) => takeLoan(tx, c.id, { product: 'term', principalCents: 10_000_00, days: 60 }));
    expect(ok.dailyRate).toBe(ready.term.dailyRate);
    expect(ok.installmentCents).toBe(Math.round(emi(10_000_00, ok.dailyRate, 60)));
  });

  it('scores a brand-new company from defaults', async () => {
    const c = await newCompany(db, { capital: 100_000_00 });
    const p = await creditProfile(db, c.id);
    expect(p.factors.repayment).toBe(0.7);
    expect(p.factors.lowDebt).toBe(1);
    expect(p.factors.ageDays).toBe(0);
    expect(p.factors.dscr).toBe(2);
    expect(p.factors.stability).toBe(0.7);
    // 300 + 600 × (0.21 + 0.2 + 0 + 0.2 + 0.105)
    expect(p.score).toBe(729);
  });
});

describe('scheduler', () => {
  it('closes each finished day exactly once', async () => {
    const c = await newCompany(db, { capital: 100_000_00 });
    await withTx(db, (tx) => buyBuilding(tx, c.id, 'farm'));
    await db.query('UPDATE companies SET last_settled_day = $2 WHERE id = $1', [c.id, today() - 3]);
    const before = await cash(db, c.id);
    await runDueClosures(db);
    expect((await company(c.id)).last_settled_day).toBe(today() - 1);
    expect(await cash(db, c.id)).toBe(before - 2 * 100_00);
    await runDueClosures(db);
    expect(await cash(db, c.id)).toBe(before - 2 * 100_00);
  });
});
