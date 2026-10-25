import { BANKRUPTCY, CREDIT_LINE, DELINQUENCY, MORTGAGE, OVERDRAFT, resaleValue, SAVINGS, STARTER_LOAN, TERM_LOAN, type LoanProduct, type LoanStatus } from '../../shared/bank';
import { creditScore, emi, rateTier, type CreditFactors } from '../../shared/economy';
import type { Db, Tx } from './db';
import { badRequest, conflict, notFound } from './errors';
import { companyAccount, systemAccount, toCents, transfer } from './ledger';
import { assetsCents, debtCents, operatingFlowCents, revenueCents } from './state';
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
  building_id: string | null;
  credit_limit_cents: number | null;
  limit_reviewed_day: number | null;
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
  const blockedOr = (minLevel: number) =>
    blockedReason ?? (c.level < minLevel ? `Unlocks at company level ${minLevel}.` : p.score < TERM_LOAN.minScore ? `Declined: credit score below ${TERM_LOAN.minScore}.` : undefined);

  // Mortgages: one per building, up to the tier's LTV × resale value.
  const mortgageReason = blockedOr(MORTGAGE.minLevel);
  const buildings = await q.query<{ id: string; name: string; level: number; build_cost_cents: number; mortgaged: boolean }>(
    `SELECT b.id, b.name, b.level, bt.build_cost_cents,
            EXISTS (SELECT 1 FROM loans l WHERE l.building_id = b.id AND l.product = 'mortgage' AND l.${OPEN}) AS mortgaged
     FROM buildings b JOIN building_types bt ON bt.id = b.building_type_id WHERE b.company_id = $1 ORDER BY b.plot`,
    [companyId],
  );
  const mortgage = {
    available: !mortgageReason,
    reason: mortgageReason,
    dailyRate: Math.max(0.0005, (p.tier.dailyRate ?? 0.004) - MORTGAGE.rateDiscount),
    maxLtv: p.tier.maxLtv,
    minDscr: p.tier.minDscr,
    terms: MORTGAGE.terms,
    minCents: toCents(MORTGAGE.minAmount),
    buildings: buildings.rows.map((b) => ({
      id: b.id,
      name: b.name,
      resaleCents: Math.round(resaleValue(Number(b.build_cost_cents), b.level)),
      maxCents: Math.floor((p.tier.maxLtv * resaleValue(Number(b.build_cost_cents), b.level)) / 10_000) * 10_000,
      mortgaged: b.mortgaged,
    })),
  };

  // Line of credit: limit = 30% of the last 7 game days' revenue.
  const limitCents = await creditLineLimit(q, companyId);
  let lineReason = blockedOr(CREDIT_LINE.minLevel);
  if (!lineReason && limitCents < toCents(CREDIT_LINE.minLimit)) {
    lineReason = `Your last 7 days of sales support less than ${CREDIT_LINE.minLimit.toLocaleString('en-US')} CR of credit.`;
  }
  const creditLine = { available: !lineReason, reason: lineReason, limitCents, dailyRate: (p.tier.dailyRate ?? 0.004) + CREDIT_LINE.rateSpread };
  return { starter, term, mortgage, creditLine };
}

/** 30% of the last 7 game days' revenue, rounded down to 100 CR. */
export async function creditLineLimit(q: Q, companyId: string): Promise<number> {
  const revenue = await revenueCents(q, companyId, new Date(Date.now() - 7 * gameDayMs()), new Date());
  return Math.floor((CREDIT_LINE.revenueShare * revenue) / 10_000) * 10_000;
}

// ---------------------------------------------------------------- borrowing

async function lockCompany(tx: Tx, companyId: string) {
  await tx.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
}

export async function takeLoan(tx: Tx, companyId: string, input: { product: 'starter' | 'term' | 'mortgage'; principalCents?: number; days?: number; buildingId?: string }) {
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
    const offer = input.product === 'mortgage' ? offers.mortgage : offers.term;
    if (!offer.available) throw conflict('not_eligible', offer.reason ?? 'Not eligible.');
    principal = input.principalCents ?? 0;
    days = input.days ?? 0;
    rate = offer.dailyRate;
    let maxCents = input.product === 'term' ? offers.term.maxCents : 0;
    if (input.product === 'mortgage') {
      const b = offers.mortgage.buildings.find((x) => x.id === input.buildingId);
      if (!b) throw notFound('Building');
      if (b.mortgaged) throw conflict('mortgaged', `${b.name} already secures a mortgage.`);
      maxCents = b.maxCents;
    }
    if (!offer.terms.includes(days)) throw badRequest(`Term must be one of ${offer.terms.join(', ')} days.`);
    if (!Number.isInteger(principal) || principal < offer.minCents || principal > maxCents) {
      throw badRequest(`Amount must be between ${offer.minCents / 100} and ${maxCents / 100} CR.`);
    }
    const installment = emi(principal, rate, days);
    const dscr = profile.avgDailyOperatingCents / (profile.dailyDebtServiceCents + installment);
    if (dscr < offer.minDscr) {
      throw conflict('dscr_too_low', `Debt cover would be ${dscr.toFixed(2)}×; the bank needs ${offer.minDscr}×. Borrow less or for longer.`);
    }
  }

  const installment = Math.round(emi(principal, rate, days));
  const today = gameDay();
  const res = await tx.query<LoanRow>(
    `INSERT INTO loans (company_id, product, principal_cents, daily_rate, term_days, installment_cents, outstanding_cents, created_day, building_id)
     VALUES ($1, $2, $3, $4, $5, $6, $3, $7, $8) RETURNING *`,
    [companyId, input.product, principal, rate, days, installment, today, input.product === 'mortgage' ? input.buildingId : null],
  );
  const loan = res.rows[0];
  if (input.product === 'starter') await tx.query('UPDATE companies SET starter_loan_taken = true WHERE id = $1', [companyId]);

  const bank = await systemAccount(tx, 'npc:bank');
  const cash = await companyAccount(tx, companyId, 'cash');
  const label = input.product === 'starter' ? 'Starter loan' : input.product === 'mortgage' ? 'Mortgage' : 'Term loan';
  await transfer(tx, 'loan_disbursement', `${label}: ${days} days at ${(rate * 100).toFixed(2)}%/day`, bank, cash, principal, `loan:${loan.id}`);
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

// ---------------------------------------------------------------- line of credit

async function openLine(tx: Tx, companyId: string): Promise<LoanRow | null> {
  return (await tx.query<LoanRow>(`SELECT * FROM loans WHERE company_id = $1 AND product = 'credit_line' AND ${OPEN} FOR UPDATE`, [companyId])).rows[0] ?? null;
}

export async function openCreditLine(tx: Tx, companyId: string) {
  await lockCompany(tx, companyId);
  if (await openLine(tx, companyId)) throw conflict('open', 'You already have a line of credit.');
  const offers = await loanOffers(tx, companyId);
  if (!offers.creditLine.available) throw conflict('not_eligible', offers.creditLine.reason ?? 'Not eligible.');
  const today = gameDay();
  const res = await tx.query<LoanRow>(
    `INSERT INTO loans (company_id, product, principal_cents, daily_rate, term_days, installment_cents, outstanding_cents, created_day, credit_limit_cents, limit_reviewed_day)
     VALUES ($1, 'credit_line', 0, $2, 0, 0, 0, $3, $4, $3) RETURNING *`,
    [companyId, offers.creditLine.dailyRate, today, offers.creditLine.limitCents],
  );
  await logLoanEvent(tx, res.rows[0], today, 'limit_review', offers.creditLine.limitCents, 'opened');
  return { loanId: res.rows[0].id, limitCents: offers.creditLine.limitCents, dailyRate: offers.creditLine.dailyRate };
}

/** Draws on the line, up to its limit. Not allowed while interest is overdue. */
export async function drawCredit(tx: Tx, companyId: string, cents: number) {
  if (!Number.isInteger(cents) || cents <= 0) throw badRequest('Draw a positive amount.');
  await lockCompany(tx, companyId);
  const line = await openLine(tx, companyId);
  if (!line) throw notFound('Line of credit');
  if (line.arrears_cents > 0) throw conflict('late', 'Pay the overdue interest before drawing again.');
  const room = Number(line.credit_limit_cents) - line.outstanding_cents;
  if (cents > room) throw conflict('over_limit', `You can draw up to ${(room / 100).toFixed(2)} CR more.`);
  await transfer(tx, 'loan_disbursement', 'Line of credit draw', await systemAccount(tx, 'npc:bank'), await companyAccount(tx, companyId, 'cash'), cents);
  line.outstanding_cents += cents;
  await tx.query('UPDATE loans SET principal_cents = principal_cents + $2 WHERE id = $1', [line.id, cents]);
  await saveLoan(tx, line);
  await logLoanEvent(tx, line, gameDay(), 'credit_draw', cents);
  return { drawnCents: line.outstanding_cents, limitCents: Number(line.credit_limit_cents) };
}

/** Repays part or all of the drawn balance (overdue interest first). The line stays open. */
export async function repayCredit(tx: Tx, companyId: string, cents: number) {
  if (!Number.isInteger(cents) || cents <= 0) throw badRequest('Repay a positive amount.');
  await lockCompany(tx, companyId);
  const line = await openLine(tx, companyId);
  if (!line) throw notFound('Line of credit');
  const paid = await applyPayment(tx, line, cents, { includeOutstanding: true, memo: 'Line of credit repayment' });
  if (line.arrears_cents === 0) {
    line.days_past_due = 0;
    line.status = 'active';
    await saveLoan(tx, line);
  }
  await logLoanEvent(tx, line, gameDay(), 'credit_repay', paid);
  return { paidCents: paid, drawnCents: line.outstanding_cents };
}

/** Weekly review at the daily close: the limit follows the last 7 days' revenue. Returns the new limit. */
export async function reviewCreditLine(tx: Tx, line: LoanRow, day: number): Promise<number> {
  const limit = await creditLineLimit(tx, line.company_id);
  await tx.query('UPDATE loans SET credit_limit_cents = $2, limit_reviewed_day = $3 WHERE id = $1', [line.id, limit, day]);
  line.credit_limit_cents = limit;
  line.limit_reviewed_day = day;
  await logLoanEvent(tx, line, day, 'limit_review', limit);
  return limit;
}

// ---------------------------------------------------------------- savings

export async function depositSavings(tx: Tx, companyId: string, cents: number) {
  if (!Number.isInteger(cents) || cents <= 0) throw badRequest('Deposit a positive amount.');
  await transfer(tx, 'savings', 'Moved to savings', await companyAccount(tx, companyId, 'cash'), await companyAccount(tx, companyId, 'savings'), cents);
  return { depositedCents: cents };
}

export async function withdrawSavings(tx: Tx, companyId: string, cents: number) {
  if (!Number.isInteger(cents) || cents <= 0) throw badRequest('Withdraw a positive amount.');
  await transfer(tx, 'savings', 'Moved from savings', await companyAccount(tx, companyId, 'savings'), await companyAccount(tx, companyId, 'cash'), cents);
  return { withdrawnCents: cents };
}

/** Daily close: savings earn 0.02%/day on balances up to 500k CR. */
export async function paySavingsInterest(tx: Tx, companyId: string): Promise<number> {
  const acct = await companyAccount(tx, companyId, 'savings');
  const bal = Number((await tx.query<{ balance_cents: number }>('SELECT balance_cents FROM accounts WHERE id = $1', [acct])).rows[0].balance_cents);
  const interest = Math.floor(Math.min(bal, toCents(SAVINGS.cap)) * SAVINGS.dailyRate);
  if (interest > 0) await transfer(tx, 'savings_interest', 'Savings interest', await systemAccount(tx, 'faucet:deposit_interest'), acct, interest);
  return interest;
}

// ---------------------------------------------------------------- overview for the client

export async function bankOverview(db: Db, companyId: string, opts: { devTools: boolean }) {
  const profile = await creditProfile(db, companyId);
  const offers = await loanOffers(db, companyId, profile);
  const [loans, events, company, upkeep, savings] = await Promise.all([
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
    db.query<{ balance_cents: number }>("SELECT balance_cents FROM accounts WHERE company_id = $1 AND kind = 'savings'", [companyId]),
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
    savings: { balanceCents: Number(savings.rows[0]?.balance_cents ?? 0), dailyRate: SAVINGS.dailyRate, capCents: toCents(SAVINGS.cap) },
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
      buildingId: l.building_id,
      creditLimitCents: l.credit_limit_cents === null ? null : Number(l.credit_limit_cents),
      limitReviewedDay: l.limit_reviewed_day,
    })),
    events: events.rows.map((e) => ({ id: e.id, loanId: e.loan_id, day: e.day, kind: e.kind, amountCents: Number(e.amount_cents), note: e.note })),
    devTools: opts.devTools,
    bankruptcy: BANKRUPTCY,
  };
}
