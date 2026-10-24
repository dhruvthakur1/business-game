import { BANKRUPTCY, DELINQUENCY, OVERDRAFT, STARTER_LOAN, TERM_LOAN, type LoanProduct, type LoanStatus } from '../../shared/bank';
import { creditScore, emi, rateTier, type CreditFactors } from '../../shared/economy';
import type { Db, Tx } from './db';
import { badRequest, conflict, notFound } from './errors';
import { companyAccount, systemAccount, toCents, transfer } from './ledger';
import { assetsCents, debtCents, operatingFlowCents } from './state';
import { gameDay, gameDayMs, gameDayStart } from './time';

type Q = Pick<Tx, 'query'>;

export interface LoanRow {
  id: string;
  company_id: string;
  product: LoanProduct;
  principal_cents: number;
  daily_rate: string;
  term_days: number;
  installment_cents: number;
  outstanding_cents: number;
  arrears_cents: number;
  arrears_principal_cents: number;
  installments_due: number;
  installments_paid: number;
  days_past_due: number;
  status: LoanStatus;
  restructured: boolean;
  created_day: number;
}

export const OPEN = "status NOT IN ('repaid', 'defaulted')";

export async function openLoans(q: Q, companyId: string, opts: { lock?: boolean } = {}): Promise<LoanRow[]> {
  const res = await q.query<LoanRow>(
    `SELECT * FROM loans WHERE company_id = $1 AND ${OPEN} ORDER BY created_at${opts.lock ? ' FOR UPDATE' : ''}`,
    [companyId],
  );
  return res.rows;
}

export async function logLoanEvent(q: Q, loan: Pick<LoanRow, 'id' | 'company_id'>, day: number, kind: string, amount = 0, note = '') {
  await q.query('INSERT INTO loan_events (loan_id, company_id, day, kind, amount_cents, note) VALUES ($1, $2, $3, $4, $5, $6)', [loan.id, loan.company_id, day, kind, amount, note]);
}

// ---------------------------------------------------------------- credit score

export interface CreditProfile {
  score: number;
  formulaScore: number;
  penalty: number;
  factors: CreditFactors;
  tier: ReturnType<typeof rateTier>;
  avgDailyOperatingCents: number;
  dailyDebtServiceCents: number;
}

/** score = 300 + 600 × weighted factors, minus penalty points from missed payments and restructuring. */
export async function creditProfile(q: Q, companyId: string): Promise<CreditProfile> {
  const company = await q.query<{ created_day: number; credit_penalty: number }>('SELECT created_day, credit_penalty FROM companies WHERE id = $1', [companyId]);
  if (!company.rows[0]) throw notFound('Company');
  const { created_day, credit_penalty } = company.rows[0];

  const history = await q.query<{ paid: number; missed: number }>(
    `SELECT COUNT(*) FILTER (WHERE kind = 'paid')::int AS paid, COUNT(*) FILTER (WHERE kind = 'missed')::int AS missed
     FROM (SELECT kind FROM loan_events WHERE company_id = $1 AND kind IN ('paid', 'missed') ORDER BY id DESC LIMIT 60) h`,
    [companyId],
  );
  const { paid, missed } = history.rows[0];
  const repayment = paid + missed === 0 ? 0.7 : paid / (paid + missed);

  const [assets, debt] = await Promise.all([assetsCents(q, companyId), debtCents(q, companyId)]);
  const lowDebt = assets <= 0 ? 0 : 1 - Math.min(1, debt / assets);

  const flow7 = await operatingFlowCents(q, companyId, new Date(Date.now() - 7 * gameDayMs()));
  const service = await q.query<{ daily: number }>(
    `SELECT COALESCE(SUM(installment_cents), 0)::bigint AS daily FROM loans WHERE company_id = $1 AND product <> 'overdraft' AND ${OPEN}`,
    [companyId],
  );
  const dailyService = Number(service.rows[0].daily);
  const dscr = dailyService === 0 ? 2 : Math.max(0, flow7 / 7 / dailyService);

  const days = await q.query<{ operating_flow_cents: number }>(
    'SELECT operating_flow_cents FROM company_days WHERE company_id = $1 ORDER BY day DESC LIMIT 14',
    [companyId],
  );
  let stability = 0.7;
  if (days.rows.length >= 3) {
    const xs = days.rows.map((d) => Number(d.operating_flow_cents));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    stability = mean <= 0 ? 0 : Math.max(0, Math.min(1, 1 - sd / mean));
  }

  const factors: CreditFactors = { repayment, lowDebt, ageDays: Math.max(0, gameDay() - created_day), dscr, stability };
  const formulaScore = creditScore(factors);
  const score = Math.max(300, formulaScore - credit_penalty);
  return { score, formulaScore, penalty: credit_penalty, factors, tier: rateTier(score), avgDailyOperatingCents: Math.round(flow7 / 7), dailyDebtServiceCents: dailyService };
}

// ---------------------------------------------------------------- offers

export interface Offer {
  available: boolean;
  reason?: string;
}

export async function loanOffers(q: Q, companyId: string, profile?: CreditProfile) {
  const p = profile ?? (await creditProfile(q, companyId));
  const c = (await q.query<{ level: number; created_day: number; starter_loan_taken: boolean; borrow_blocked_until: number | null }>(
    'SELECT level, created_day, starter_loan_taken, borrow_blocked_until FROM companies WHERE id = $1',
    [companyId],
  )).rows[0];
  const today = gameDay();
  const blocked = c.borrow_blocked_until !== null && today < c.borrow_blocked_until;
  const blockedReason = blocked ? `New borrowing is paused until game day ${c.borrow_blocked_until}.` : undefined;

  const starter: Offer & { amountCents: number; days: number; dailyRate: number; installmentCents: number } = {
    available: !blocked && !c.starter_loan_taken && c.level >= STARTER_LOAN.minLevel,
    reason: blockedReason ?? (c.starter_loan_taken ? 'Already used: the starter loan is once per company.' : c.level < STARTER_LOAN.minLevel ? `Unlocks at company level ${STARTER_LOAN.minLevel}.` : undefined),
    amountCents: toCents(STARTER_LOAN.amount),
    days: STARTER_LOAN.days,
    dailyRate: STARTER_LOAN.dailyRate,
    installmentCents: Math.round(emi(toCents(STARTER_LOAN.amount), STARTER_LOAN.dailyRate, STARTER_LOAN.days)),
  };

  const maxCents = Math.max(0, Math.floor((TERM_LOAN.limitMultiple * p.avgDailyOperatingCents) / 10_000) * 10_000);
  let reason: string | undefined = blockedReason;
  if (!reason && c.level < TERM_LOAN.minLevel) reason = `Unlocks at company level ${TERM_LOAN.minLevel}.`;
  if (!reason && today - c.created_day < TERM_LOAN.minAgeDays) reason = `Your company must be ${TERM_LOAN.minAgeDays} game days old.`;
  if (!reason && p.score < TERM_LOAN.minScore) reason = `Declined: credit score below ${TERM_LOAN.minScore}.`;
  if (!reason && maxCents < toCents(TERM_LOAN.minAmount)) reason = `Your 7-day operating cash flow supports less than ${TERM_LOAN.minAmount.toLocaleString('en-US')} CR.`;
  const term = {
    available: !reason,
    reason,
    maxCents,
    minCents: toCents(TERM_LOAN.minAmount),
    dailyRate: p.tier.dailyRate ?? 0.004,
    minDscr: p.tier.minDscr,
    terms: TERM_LOAN.terms,
  };
  return { starter, term };
}

// ---------------------------------------------------------------- borrowing

async function lockCompany(tx: Tx, companyId: string) {
  await tx.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
}

export async function takeLoan(tx: Tx, companyId: string, input: { product: 'starter' | 'term'; principalCents?: number; days?: number }) {
  await lockCompany(tx, companyId);
  const profile = await creditProfile(tx, companyId);
  const offers = await loanOffers(tx, companyId, profile);
  let principal: number;
  let days: number;
  let rate: number;

  if (input.product === 'starter') {
    if (!offers.starter.available) throw conflict('not_eligible', offers.starter.reason ?? 'Not eligible.');
    principal = offers.starter.amountCents;
    days = offers.starter.days;
    rate = offers.starter.dailyRate;
  } else {
    if (!offers.term.available) throw conflict('not_eligible', offers.term.reason ?? 'Not eligible.');
    principal = input.principalCents ?? 0;
    days = input.days ?? 0;
    rate = offers.term.dailyRate;
    if (!TERM_LOAN.terms.includes(days)) throw badRequest(`Term must be one of ${TERM_LOAN.terms.join(', ')} days.`);
    if (!Number.isInteger(principal) || principal < offers.term.minCents || principal > offers.term.maxCents) {
      throw badRequest(`Amount must be between ${offers.term.minCents / 100} and ${offers.term.maxCents / 100} CR.`);
    }
    const installment = emi(principal, rate, days);
    const dscr = profile.avgDailyOperatingCents / (profile.dailyDebtServiceCents + installment);
    if (dscr < offers.term.minDscr) {
      throw conflict('dscr_too_low', `Debt cover would be ${dscr.toFixed(2)}×; the bank needs ${offers.term.minDscr}×. Borrow less or for longer.`);
    }
  }

  const installment = Math.round(emi(principal, rate, days));
  const today = gameDay();
  const res = await tx.query<LoanRow>(
    `INSERT INTO loans (company_id, product, principal_cents, daily_rate, term_days, installment_cents, outstanding_cents, created_day)
     VALUES ($1, $2, $3, $4, $5, $6, $3, $7) RETURNING *`,
    [companyId, input.product, principal, rate, days, installment, today],
  );
  const loan = res.rows[0];
  if (input.product === 'starter') await tx.query('UPDATE companies SET starter_loan_taken = true WHERE id = $1', [companyId]);

  const bank = await systemAccount(tx, 'npc:bank');
  const cash = await companyAccount(tx, companyId, 'cash');
  await transfer(tx, 'loan_disbursement', `${input.product === 'starter' ? 'Starter' : 'Term'} loan: ${days} days at ${(rate * 100).toFixed(2)}%/day`, bank, cash, principal, `loan:${loan.id}`);
  await logLoanEvent(tx, loan, today, 'disbursed', principal);
  return { loanId: loan.id, principalCents: principal, installmentCents: installment, dailyRate: rate, days };
}

/**
 * Applies a payment to a loan: interest and fees in arrears first (destroyed), then principal
 * in arrears, then outstanding principal (both returned to the bank).
 * Returns how much was actually paid.
 */
export async function applyPayment(tx: Tx, loan: LoanRow, maxCents: number, opts: { includeOutstanding?: boolean; memo?: string } = {}): Promise<number> {
  const interestOwed = loan.arrears_cents - loan.arrears_principal_cents;
  const owed = loan.arrears_cents + (opts.includeOutstanding ? loan.outstanding_cents : 0);
  const pay = Math.max(0, Math.min(maxCents, owed));
  if (pay === 0) return 0;
  const toInterest = Math.min(pay, interestOwed);
  const toArrearsPrincipal = Math.min(pay - toInterest, loan.arrears_principal_cents);
  const toOutstanding = pay - toInterest - toArrearsPrincipal;

  const cash = await companyAccount(tx, loan.company_id, 'cash');
  const bank = await systemAccount(tx, 'npc:bank');
  const sink = await systemAccount(tx, 'sink:interest');
  const memo = opts.memo ?? 'Loan payment';
  if (toInterest > 0) await transfer(tx, 'loan_payment', `${memo} (interest & fees)`, cash, sink, toInterest);
  if (toArrearsPrincipal + toOutstanding > 0) await transfer(tx, 'loan_payment', `${memo} (principal)`, cash, bank, toArrearsPrincipal + toOutstanding);

  loan.arrears_cents -= toInterest + toArrearsPrincipal;
  loan.arrears_principal_cents -= toArrearsPrincipal;
  loan.outstanding_cents -= toOutstanding;
  await saveLoan(tx, loan);
  return pay;
}

export async function saveLoan(tx: Tx, loan: LoanRow) {
  await tx.query(
    `UPDATE loans SET outstanding_cents = $2, arrears_cents = $3, arrears_principal_cents = $4, installments_due = $5,
       installments_paid = $6, days_past_due = $7, status = $8, restructured = $9, daily_rate = $10, term_days = $11,
       installment_cents = $12
     WHERE id = $1`,
    [loan.id, loan.outstanding_cents, loan.arrears_cents, loan.arrears_principal_cents, loan.installments_due, loan.installments_paid,
      loan.days_past_due, loan.status, loan.restructured, loan.daily_rate, loan.term_days, loan.installment_cents],
  );
}

async function lockLoan(tx: Tx, companyId: string, loanId: string): Promise<LoanRow> {
  const res = await tx.query<LoanRow>(`SELECT * FROM loans WHERE id = $1 AND company_id = $2 FOR UPDATE`, [loanId, companyId]);
  if (!res.rows[0]) throw notFound('Loan');
  return res.rows[0];
}

/** Pays off a loan early: arrears plus outstanding principal. No prepayment penalty. */
export async function repayLoan(tx: Tx, companyId: string, loanId: string) {
  await lockCompany(tx, companyId);
  const loan = await lockLoan(tx, companyId, loanId);
  if (loan.status === 'repaid' || loan.status === 'defaulted') throw conflict('closed', 'This loan is already closed.');
  const owed = loan.arrears_cents + loan.outstanding_cents;
  const cash = await tx.query<{ balance_cents: number }>("SELECT balance_cents FROM accounts WHERE company_id = $1 AND kind = 'cash'", [companyId]);
  if (cash.rows[0].balance_cents < owed) throw conflict('insufficient_funds', `Paying this off takes ${(owed / 100).toFixed(2)} CR.`);
  await applyPayment(tx, loan, owed, { includeOutstanding: true, memo: 'Early repayment' });
  loan.status = 'repaid';
  loan.days_past_due = 0;
  await saveLoan(tx, loan);
  await logLoanEvent(tx, loan, gameDay(), 'repaid', owed);
  return { loanId, paidCents: owed };
}

/**
 * Accepts the day-3 restructuring offer: arrears fold into principal, the remaining term doubles,
 * the rate rises by 0.05%/day, the score drops 30 and new borrowing pauses for 14 game days.
 */
export async function restructureLoan(tx: Tx, companyId: string, loanId: string) {
  await lockCompany(tx, companyId);
  const loan = await lockLoan(tx, companyId, loanId);
  if (loan.status !== 'restructure_offered') throw conflict('no_offer', 'There is no restructuring offer on this loan.');
  const remaining = Math.max(1, loan.term_days - loan.installments_due);
  const newRemaining = remaining * 2;
  const rate = Number(loan.daily_rate) + DELINQUENCY.restructureRateBump;
  loan.outstanding_cents += loan.arrears_cents;
  loan.arrears_cents = 0;
  loan.arrears_principal_cents = 0;
  loan.daily_rate = rate.toFixed(6);
  loan.term_days = loan.installments_due + newRemaining;
  loan.installment_cents = Math.round(emi(loan.outstanding_cents, rate, newRemaining));
  loan.days_past_due = 0;
  loan.status = 'active';
  loan.restructured = true;
  await saveLoan(tx, loan);
  const today = gameDay();
  await tx.query(
    'UPDATE companies SET credit_penalty = credit_penalty + $2, borrow_blocked_until = $3 WHERE id = $1',
    [companyId, DELINQUENCY.restructureScorePenalty, today + DELINQUENCY.borrowBlockDays],
  );
  await logLoanEvent(tx, loan, today, 'restructured', loan.outstanding_cents, `${newRemaining} days at ${(rate * 100).toFixed(2)}%/day`);
  return { loanId, installmentCents: loan.installment_cents, termDays: newRemaining, dailyRate: rate };
}

// ---------------------------------------------------------------- overview for the client

export async function bankOverview(db: Db, companyId: string, opts: { devTools: boolean }) {
  const profile = await creditProfile(db, companyId);
  const offers = await loanOffers(db, companyId, profile);
  const [loans, events, company, upkeep] = await Promise.all([
    db.query<LoanRow>(
      `SELECT * FROM loans WHERE company_id = $1 AND (${OPEN} OR created_at > now() - interval '30 days') ORDER BY created_at DESC LIMIT 20`,
      [companyId],
    ),
    db.query('SELECT id, loan_id, day, kind, amount_cents, note FROM loan_events WHERE company_id = $1 ORDER BY id DESC LIMIT 15', [companyId]),
    db.query<{ last_settled_day: number; upkeep_arrears_cents: number; borrow_blocked_until: number | null; bankruptcies: number }>(
      'SELECT last_settled_day, upkeep_arrears_cents, borrow_blocked_until, bankruptcies FROM companies WHERE id = $1',
      [companyId],
    ),
    db.query<{ daily: number }>(
      `SELECT COALESCE(SUM(bt.upkeep_per_day_cents * b.level), 0)::bigint AS daily
       FROM buildings b JOIN building_types bt ON bt.id = b.building_type_id WHERE b.company_id = $1`,
      [companyId],
    ),
  ]);
  const today = gameDay();
  return {
    day: today,
    lastSettledDay: company.rows[0].last_settled_day,
    nextCloseAt: gameDayStart(today + 1).toISOString(),
    credit: profile,
    offers,
    upkeep: { dailyCents: Number(upkeep.rows[0].daily), arrearsCents: Number(company.rows[0].upkeep_arrears_cents) },
    overdraft: { limitCents: toCents(OVERDRAFT.limit), dailyRate: OVERDRAFT.dailyRate, drawFeeCents: toCents(OVERDRAFT.drawFee) },
    borrowBlockedUntil: company.rows[0].borrow_blocked_until,
    bankruptcies: company.rows[0].bankruptcies,
    loans: loans.rows.map((l) => ({
      id: l.id,
      product: l.product,
      status: l.status,
      principalCents: l.principal_cents,
      dailyRate: Number(l.daily_rate),
      termDays: l.term_days,
      installmentCents: l.installment_cents,
      outstandingCents: l.outstanding_cents,
      arrearsCents: l.arrears_cents,
      installmentsDue: l.installments_due,
      installmentsPaid: l.installments_paid,
      daysPastDue: l.days_past_due,
      restructured: l.restructured,
      createdDay: l.created_day,
    })),
    events: events.rows.map((e) => ({ id: e.id, loanId: e.loan_id, day: e.day, kind: e.kind, amountCents: Number(e.amount_cents), note: e.note })),
    devTools: opts.devTools,
    bankruptcy: BANKRUPTCY,
  };
}
