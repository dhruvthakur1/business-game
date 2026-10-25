import { BANKRUPTCY, CREDIT_LINE, DELINQUENCY, OVERDRAFT, RECEIVERSHIP } from '../../shared/bank';
import { updateReputation } from './brands';
import { closeOwnerDay } from './wealth';
import { creditScore } from '../../shared/economy';
import { OPEN, applyPayment, creditProfile, logLoanEvent, openLoans, paySavingsInterest, reviewCreditLine, saveLoan, type LoanRow } from './bank';
import { type Db, type Tx, withTx } from './db';
import { cancelOrder } from './exchange';
import { companyAccount, systemAccount, toCents, transfer } from './ledger';
import { operatingFlowCents, revenueCents } from './state';
import { gameDay, gameDayStart } from './time';

/** Days missed while the server was down are replayed, but only this many. */
const MAX_CATCH_UP_DAYS = 7;

const cashOf = async (tx: Tx, companyId: string) =>
  (await tx.query<{ balance_cents: number }>("SELECT balance_cents FROM accounts WHERE company_id = $1 AND kind = 'cash'", [companyId])).rows[0].balance_cents;

export interface DayReport {
  day: number;
  installmentsPaidCents: number;
  missed: number;
  upkeepPaidCents: number;
  upkeepShortCents: number;
  overdraftDrawCents: number;
  receivership: boolean;
  bankrupt: boolean;
  salaryPaidCents: number;
}

/**
 * Closes one game day for a company, in this order:
 * 1. loan installments (due at 00:00, before upkeep), with late fees and the delinquency ladder;
 * 2. upkeep for every building, drawing on the overdraft if cash runs short;
 * 3. overdraft interest and automatic repayment;
 * 4. receivership if any loan is 14+ days past due;
 * 5. brand reputation and a daily snapshot used by the credit score;
 * 6. the owner's salary from company cash, then item upkeep from the wallet.
 */
export async function closeDay(tx: Tx, companyId: string, day: number): Promise<DayReport> {
  const report: DayReport = { day, installmentsPaidCents: 0, missed: 0, upkeepPaidCents: 0, upkeepShortCents: 0, overdraftDrawCents: 0, receivership: false, bankrupt: false, salaryPaidCents: 0 };
  const company = (await tx.query<{ upkeep_arrears_cents: number; is_npc: boolean }>(
    'SELECT upkeep_arrears_cents, is_npc FROM companies WHERE id = $1 FOR UPDATE',
    [companyId],
  )).rows[0];
  const dayStart = gameDayStart(day);
  const dayEnd = gameDayStart(day + 1);

  // 1. Installments
  const loans = await openLoans(tx, companyId, { lock: true });
  let penaltyDelta = 0;
  for (const loan of loans.filter((l) => l.product !== 'overdraft')) {
    if (loan.created_day >= day) continue; // first installment is due at the close after the loan's first day
    const rate = Number(loan.daily_rate);

    // Penalty interest on anything already overdue.
    if (loan.arrears_cents > 0) loan.arrears_cents += Math.round(loan.arrears_cents * DELINQUENCY.penaltyRate);

    let installment = 0;
    if (loan.product === 'credit_line') {
      // Revolving: the limit is reviewed weekly; interest is charged daily on the drawn balance only.
      if (day - (loan.limit_reviewed_day ?? loan.created_day) >= CREDIT_LINE.reviewDays) await reviewCreditLine(tx, loan, day);
      const interest = Math.round(loan.outstanding_cents * rate);
      if (interest > 0) {
        installment = interest;
        loan.arrears_cents += interest;
        loan.installments_due += 1;
      }
    } else if (loan.installments_due < loan.term_days && loan.outstanding_cents > 0) {
      const interest = Math.round(loan.outstanding_cents * rate);
      const last = loan.installments_due === loan.term_days - 1;
      const principalPart = last ? loan.outstanding_cents : Math.min(loan.outstanding_cents, Math.max(0, loan.installment_cents - interest));
      installment = interest + principalPart;
      loan.outstanding_cents -= principalPart;
      loan.arrears_cents += installment;
      loan.arrears_principal_cents += principalPart;
      loan.installments_due += 1;
    }
    await saveLoan(tx, loan);

    const cash = await cashOf(tx, companyId);
    if (loan.days_past_due >= DELINQUENCY.collectionsAtDays) {
      // Collections: the bank sweeps half of yesterday's revenue, whatever that covers.
      const sweep = Math.min(cash, Math.round(DELINQUENCY.collectionsSweepPct * (await revenueCents(tx, companyId, dayStart, dayEnd))));
      const paid = await applyPayment(tx, loan, sweep, { memo: 'Collections sweep' });
      if (paid > 0) await logLoanEvent(tx, loan, day, 'collections', paid);
      report.installmentsPaidCents += paid;
    } else if (loan.arrears_cents > 0 && cash >= loan.arrears_cents) {
      const paid = await applyPayment(tx, loan, loan.arrears_cents, { memo: 'Daily installment' });
      report.installmentsPaidCents += paid;
      if (installment > 0) {
        loan.installments_paid += 1;
        await logLoanEvent(tx, loan, day, 'paid', paid);
        penaltyDelta -= DELINQUENCY.onTimeScoreRecovery;
      }
      loan.days_past_due = 0;
      loan.status = 'active';
    }

    if (loan.arrears_cents > 0) {
      if (installment > 0 && loan.days_past_due < DELINQUENCY.collectionsAtDays) {
        const fee = Math.round(installment * DELINQUENCY.lateFeePct);
        loan.arrears_cents += fee;
        await logLoanEvent(tx, loan, day, 'missed', installment);
        await logLoanEvent(tx, loan, day, 'late_fee', fee);
        penaltyDelta += DELINQUENCY.missedScorePenalty;
        report.missed += 1;
      }
      loan.days_past_due += 1;
      if (loan.days_past_due >= DELINQUENCY.collectionsAtDays) loan.status = 'collections';
      else if (loan.days_past_due >= DELINQUENCY.restructureAtDays && !loan.restructured) loan.status = 'restructure_offered';
      else if (loan.status !== 'restructure_offered') loan.status = 'late';
    } else if (loan.product !== 'credit_line' && loan.outstanding_cents === 0 && loan.installments_due >= loan.term_days) {
      loan.status = 'repaid';
      await logLoanEvent(tx, loan, day, 'repaid');
    }
    await saveLoan(tx, loan);
  }

  // 2. Upkeep
  const upkeep = (await tx.query<{ daily: number }>(
    `SELECT COALESCE(SUM(bt.upkeep_per_day_cents * b.level), 0)::bigint AS daily
     FROM buildings b JOIN building_types bt ON bt.id = b.building_type_id WHERE b.company_id = $1`,
    [companyId],
  )).rows[0].daily;
  const upkeepDue = Number(upkeep) + Number(company.upkeep_arrears_cents);
  const cashAcct = await companyAccount(tx, companyId, 'cash');
  const upkeepSink = await systemAccount(tx, 'sink:upkeep');
  let cash = await cashOf(tx, companyId);
  let short = Math.max(0, upkeepDue - cash);

  let overdraft = loans.find((l) => l.product === 'overdraft');
  if (short > 0 && !company.is_npc) {
    const room = toCents(OVERDRAFT.limit) - (overdraft?.outstanding_cents ?? 0);
    const draw = Math.min(short, Math.max(0, room));
    if (draw > 0) {
      if (!overdraft) {
        overdraft = (await tx.query<LoanRow>(
          `INSERT INTO loans (company_id, product, principal_cents, daily_rate, term_days, installment_cents, outstanding_cents, created_day)
           VALUES ($1, 'overdraft', 0, $2, 0, 0, 0, $3) RETURNING *`,
          [companyId, OVERDRAFT.dailyRate, day],
        )).rows[0];
      }
      const bank = await systemAccount(tx, 'npc:bank');
      await transfer(tx, 'loan_disbursement', 'Overdraft drawn to cover upkeep', bank, cashAcct, draw);
      overdraft.outstanding_cents += draw;
      overdraft.principal_cents += draw;
      overdraft.arrears_cents += toCents(OVERDRAFT.drawFee);
      await tx.query('UPDATE loans SET principal_cents = $2 WHERE id = $1', [overdraft.id, overdraft.principal_cents]);
      await saveLoan(tx, overdraft);
      await logLoanEvent(tx, overdraft, day, 'overdraft_draw', draw, `fee ${OVERDRAFT.drawFee} CR`);
      report.overdraftDrawCents = draw;
      cash += draw;
      short -= draw;
    }
  }
  const upkeepPaid = Math.min(cash, upkeepDue);
  if (upkeepPaid > 0) await transfer(tx, 'upkeep', 'Daily building upkeep', cashAcct, upkeepSink, upkeepPaid);
  await tx.query('UPDATE companies SET upkeep_arrears_cents = $2 WHERE id = $1', [companyId, upkeepDue - upkeepPaid]);
  report.upkeepPaidCents = upkeepPaid;
  report.upkeepShortCents = upkeepDue - upkeepPaid;

  // 3. Overdraft interest, then repay what cash allows.
  if (overdraft && overdraft.status !== 'repaid') {
    if (report.overdraftDrawCents === 0 && overdraft.outstanding_cents > 0) {
      overdraft.arrears_cents += Math.round(overdraft.outstanding_cents * OVERDRAFT.dailyRate);
      await saveLoan(tx, overdraft);
    }
    const available = await cashOf(tx, companyId);
    if (available > 0) await applyPayment(tx, overdraft, available, { includeOutstanding: true, memo: 'Overdraft repayment' });
    if (overdraft.outstanding_cents === 0 && overdraft.arrears_cents === 0) {
      overdraft.status = 'repaid';
      await saveLoan(tx, overdraft);
    }
  }

  if (penaltyDelta !== 0) {
    await tx.query('UPDATE companies SET credit_penalty = GREATEST(0, credit_penalty + $2) WHERE id = $1', [companyId, penaltyDelta]);
  }

  // 3b. Savings interest (a small, capped faucet).
  await paySavingsInterest(tx, companyId);

  // 4. Receivership
  const defaulting = (await openLoans(tx, companyId)).filter((l) => l.product !== 'overdraft' && l.days_past_due >= DELINQUENCY.receivershipAtDays);
  if (defaulting.length > 0) {
    report.receivership = true;
    report.bankrupt = await receivership(tx, companyId, day);
  }

  // 5. Brand reputation
  await updateReputation(tx, companyId, day);

  // 6. Snapshot
  const service = (await openLoans(tx, companyId)).filter((l) => l.product !== 'overdraft').reduce((s, l) => s + Number(l.installment_cents), 0);
  await tx.query(
    `INSERT INTO company_days (company_id, day, operating_flow_cents, upkeep_cents, debt_service_cents, cash_cents)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (company_id, day) DO NOTHING`,
    [companyId, day, await operatingFlowCents(tx, companyId, dayStart, dayEnd), upkeepPaid, service, await cashOf(tx, companyId)],
  );
  // 7. Owner: salary from company cash, then item upkeep from the wallet (skipped in receivership).
  if (!report.receivership) {
    const owner = await closeOwnerDay(tx, companyId, day);
    report.salaryPaidCents = owner.salaryPaid;
  }
  await tx.query('UPDATE companies SET last_settled_day = GREATEST(last_settled_day, $2) WHERE id = $1', [companyId, day]);
  return report;
}

/**
 * Sells assets to cover defaulting loans: open orders are cancelled, inventory goes to the NPC liquidator at
 * 80% of min(base, reference), then buildings (idle before active, newest first) at 60% of resale value.
 * The company's first building, level, wallet and cosmetics are protected.
 * Returns true if debts still could not be covered and the company was restarted (bankruptcy).
 */
export async function receivership(tx: Tx, companyId: string, day: number): Promise<boolean> {
  const liquidator = await systemAccount(tx, 'npc:liquidator');
  const cash = await companyAccount(tx, companyId, 'cash');
  // Savings are company money: they go to the debts first.
  const savings = await companyAccount(tx, companyId, 'savings');
  const saved = Number((await tx.query<{ balance_cents: number }>('SELECT balance_cents FROM accounts WHERE id = $1', [savings])).rows[0].balance_cents);
  if (saved > 0) await transfer(tx, 'savings', 'Receivership: savings applied to debts', savings, cash, saved);

  const owed = async () => (await openLoans(tx, companyId)).reduce((s, l) => s + l.outstanding_cents + l.arrears_cents, 0);
  const payDown = async () => {
    for (const loan of await openLoans(tx, companyId, { lock: true })) {
      const available = await cashOf(tx, companyId);
      if (available <= 0) break;
      const paid = await applyPayment(tx, loan, available, { includeOutstanding: true, memo: 'Receivership repayment' });
      if (paid > 0) await logLoanEvent(tx, loan, day, 'liquidation', paid);
      if (loan.outstanding_cents === 0 && loan.arrears_cents === 0) {
        loan.status = 'repaid';
        loan.days_past_due = 0;
        await saveLoan(tx, loan);
        await logLoanEvent(tx, loan, day, 'repaid');
      }
    }
  };

  const orders = await tx.query<{ id: string }>("SELECT id FROM orders WHERE company_id = $1 AND status = 'open'", [companyId]);
  for (const o of orders.rows) await cancelOrder(tx, companyId, o.id);

  const goods = await tx.query<{ product_id: string; quality: number; qty: number; price: number }>(
    `SELECT i.product_id, i.quality, i.qty, LEAST(p.ref_price_cents, COALESCE(r.price_cents, p.ref_price_cents)) AS price
     FROM inventory i JOIN products p ON p.id = i.product_id LEFT JOIN reference_prices r ON r.product_id = p.id
     WHERE i.company_id = $1 AND i.qty > 0`,
    [companyId],
  );
  let proceeds = 0;
  for (const g of goods.rows) proceeds += Math.round(g.qty * g.price * RECEIVERSHIP.inventoryFactor);
  if (proceeds > 0) {
    await tx.query('UPDATE inventory SET qty = 0 WHERE company_id = $1', [companyId]);
    await transfer(tx, 'liquidation', 'Receivership: warehouse sold', liquidator, cash, proceeds);
  }
  await payDown();

  if ((await owed()) > 0) {
    const buildings = await tx.query<{ id: string; name: string; invested: number; running: boolean }>(
      `SELECT b.id, b.name, bt.build_cost_cents * b.level AS invested,
              EXISTS (SELECT 1 FROM production_jobs j WHERE j.building_id = b.id AND j.state = 'running') AS running
       FROM buildings b JOIN building_types bt ON bt.id = b.building_type_id
       WHERE b.company_id = $1
         AND b.id <> (SELECT id FROM buildings WHERE company_id = $1 ORDER BY created_at, plot LIMIT 1)
       ORDER BY running ASC, b.created_at DESC`,
      [companyId],
    );
    for (const b of buildings.rows) {
      if ((await owed()) === 0) break;
      const price = Math.round(Number(b.invested) * RECEIVERSHIP.resaleFactor * RECEIVERSHIP.buildingFactor);
      // A mortgage's lien: the building's sale repays that mortgage before anything else.
      const lien = (await tx.query<LoanRow>(`SELECT * FROM loans WHERE building_id = $1 AND product = 'mortgage' AND ${OPEN} FOR UPDATE`, [b.id])).rows[0];
      await tx.query('DELETE FROM buildings WHERE id = $1', [b.id]);
      await transfer(tx, 'liquidation', `Receivership: sold ${b.name}`, liquidator, cash, price);
      if (lien) {
        const paid = await applyPayment(tx, lien, price, { includeOutstanding: true, memo: `Mortgage lien on ${b.name}` });
        if (paid > 0) await logLoanEvent(tx, lien, day, 'liquidation', paid, `${b.name} sold`);
        if (lien.outstanding_cents === 0 && lien.arrears_cents === 0) {
          lien.status = 'repaid';
          lien.days_past_due = 0;
          await saveLoan(tx, lien);
          await logLoanEvent(tx, lien, day, 'repaid');
        }
      }
      await payDown();
    }
  }

  const remaining = await owed();
  if (remaining === 0) {
    await tx.query('UPDATE companies SET borrow_blocked_until = $2 WHERE id = $1', [companyId, day + DELINQUENCY.borrowBlockDays]);
    return false;
  }

  // Bankruptcy: write off what is left, restart with fresh cash, credit score reset to 450.
  for (const loan of await openLoans(tx, companyId, { lock: true })) {
    loan.status = 'defaulted';
    await saveLoan(tx, loan);
    await logLoanEvent(tx, loan, day, 'defaulted', loan.outstanding_cents + loan.arrears_cents, 'written off');
  }
  const balance = await cashOf(tx, companyId);
  const grant = Math.max(0, toCents(BANKRUPTCY.restartCash) - balance);
  if (grant > 0) await transfer(tx, 'bankruptcy_grant', 'Bankruptcy restart capital', await systemAccount(tx, 'faucet:bankruptcy'), cash, grant);
  await tx.query('UPDATE companies SET upkeep_arrears_cents = 0, bankruptcies = bankruptcies + 1, credit_penalty = 0 WHERE id = $1', [companyId]);
  const profile = await creditProfile(tx, companyId);
  const base = creditScore(profile.factors);
  await tx.query('UPDATE companies SET credit_penalty = $2, borrow_blocked_until = $3 WHERE id = $1', [companyId, Math.max(0, base - BANKRUPTCY.score), day + 7]);
  return true;
}

/** Closes every finished game day for every company. Safe to call repeatedly and concurrently. */
export async function runDueClosures(db: Db, now = Date.now()): Promise<number> {
  const today = gameDay(now);
  await db.query('UPDATE companies SET last_settled_day = $1 WHERE last_settled_day < $1', [today - 1 - MAX_CATCH_UP_DAYS]);
  const due = await db.query<{ id: string; last_settled_day: number }>('SELECT id, last_settled_day FROM companies WHERE last_settled_day < $1', [today - 1]);
  let closed = 0;
  for (const c of due.rows) {
    for (let d = c.last_settled_day + 1; d <= today - 1; d++) {
      const done = await withTx(db, async (tx) => {
        // Another worker may have closed this day already.
        const cur = await tx.query<{ last_settled_day: number }>('SELECT last_settled_day FROM companies WHERE id = $1 FOR UPDATE', [c.id]);
        if (cur.rows[0].last_settled_day >= d) return false;
        await closeDay(tx, c.id, d);
        return true;
      });
      if (done) closed += 1;
    }
  }
  return closed;
}

/** Development helper: closes the company's next unsettled day right now, even if it has not ended yet. */
export async function closeNextDay(db: Db, companyId: string): Promise<DayReport> {
  return withTx(db, async (tx) => {
    const cur = await tx.query<{ last_settled_day: number }>('SELECT last_settled_day FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    return closeDay(tx, companyId, cur.rows[0].last_settled_day + 1);
  });
}
