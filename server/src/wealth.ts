import { personalIncomeTax } from '../../shared/economy';
import { ALL_ITEMS, CATEGORY_RULES, itemById, itemUpkeep, LADDERS, PAY_RULES, prestigeScore } from '../../shared/wealth';
import { config } from './config';
import type { Db, Tx } from './db';
import { badRequest, conflict, notFound } from './errors';
import { companyAccount, systemAccount, toCents, transfer, post } from './ledger';
import { gameDay, gameDayStart } from './time';

type Q = Pick<Tx, 'query'>;
export type PayoutKind = 'salary' | 'dividend' | 'withdrawal';

/** What the company can pay its owner right now, and why not if it can't. */
export async function payoutLimits(q: Q, companyId: string, day = gameDay()) {
  const [cash, days, upkeep, service, paid, delinquent] = await Promise.all([
    q.query<{ balance_cents: number }>("SELECT balance_cents FROM accounts WHERE company_id = $1 AND kind = 'cash'", [companyId]),
    q.query<{ op7: number; n7: number; op30: number }>(
      `SELECT COALESCE(SUM(operating_flow_cents) FILTER (WHERE day > $2::int - 7), 0)::bigint AS op7,
              count(*) FILTER (WHERE day > $2::int - 7)::int AS n7,
              COALESCE(SUM(operating_flow_cents) FILTER (WHERE day > $2::int - $3::int), 0)::bigint AS op30
       FROM company_days WHERE company_id = $1 AND day <= $2::int`,
      [companyId, day, PAY_RULES.windowDays],
    ),
    q.query<{ daily: number }>(
      `SELECT COALESCE(SUM(bt.upkeep_per_day_cents * b.level), 0)::bigint AS daily
       FROM buildings b JOIN building_types bt ON bt.id = b.building_type_id WHERE b.company_id = $1`,
      [companyId],
    ),
    q.query<{ daily: number }>(
      "SELECT COALESCE(SUM(installment_cents), 0)::bigint AS daily FROM loans WHERE company_id = $1 AND product <> 'overdraft' AND status NOT IN ('repaid', 'defaulted')",
      [companyId],
    ),
    q.query<{ all30: number }>(
      'SELECT COALESCE(SUM(gross_cents), 0)::bigint AS all30 FROM owner_payouts WHERE company_id = $1 AND day > $2::int - $3::int',
      [companyId, day, PAY_RULES.windowDays],
    ),
    q.query<{ late: boolean }>(
      `SELECT (EXISTS (SELECT 1 FROM loans WHERE company_id = $1 AND status IN ('late', 'restructure_offered', 'collections'))
               OR (SELECT upkeep_arrears_cents FROM companies WHERE id = $1) > 0) AS late`,
      [companyId],
    ),
  ]);
  const cashCents = Number(cash.rows[0].balance_cents);
  const d = days.rows[0];
  const avgOpProfit7d = d.n7 > 0 ? Math.round(Number(d.op7) / d.n7) : 0;
  const salaryCapCents = Math.max(0, Math.round(PAY_RULES.salaryShare * avgOpProfit7d));
  const reserveCents = PAY_RULES.reserveDays * (Number(upkeep.rows[0].daily) + Number(service.rows[0].daily));
  const spare = Math.max(0, cashCents - reserveCents);
  const paid30 = Number(paid.rows[0].all30);
  const blocked = delinquent.rows[0].late ? 'Clear late loan payments and unpaid upkeep before paying yourself.' : null;
  return {
    cashCents,
    avgOpProfit7dCents: avgOpProfit7d,
    salaryCapCents,
    reserveCents,
    profit30dCents: Number(d.op30),
    paidOut30dCents: paid30,
    dividendAvailableCents: blocked ? 0 : Math.min(spare, Math.max(0, Number(d.op30) - paid30)),
    withdrawableCents: blocked ? 0 : spare,
    blocked,
  };
}

/** Gross payouts in the 30 game days up to `day` (the base for income-tax bands). */
export async function inflows30d(q: Q, companyId: string, day = gameDay()): Promise<number> {
  const res = await q.query<{ n: number }>(
    'SELECT COALESCE(SUM(gross_cents), 0)::bigint AS n FROM owner_payouts WHERE company_id = $1 AND day > $2::int - $3::int',
    [companyId, day, PAY_RULES.windowDays],
  );
  return Number(res.rows[0].n);
}

/** Income tax (cents) on a new gross payout, given what was already paid out in the window. */
export function payoutTax(priorCents: number, grossCents: number, kind: PayoutKind): number {
  const income = toCents(personalIncomeTax((priorCents + grossCents) / 100) - personalIncomeTax(priorCents / 100));
  const extra = kind === 'withdrawal' ? Math.round(grossCents * PAY_RULES.withdrawalTax) : 0;
  return Math.min(grossCents, income + extra);
}

/** Moves money from company cash to the owner's wallet, with tax to the income-tax sink, in one transaction. */
async function payOwner(tx: Tx, companyId: string, kind: PayoutKind, grossCents: number, day: number) {
  const tax = payoutTax(await inflows30d(tx, companyId, day), grossCents, kind);
  const label = kind === 'salary' ? 'Owner salary' : kind === 'dividend' ? 'Dividend' : 'Owner withdrawal';
  await post(tx, {
    kind: 'owner_payout',
    memo: `${label} (${(tax / 100).toFixed(2)} CR tax)`,
    entries: [
      { accountId: await companyAccount(tx, companyId, 'cash'), amount: -grossCents },
      { accountId: await companyAccount(tx, companyId, 'wallet'), amount: grossCents - tax },
      { accountId: await systemAccount(tx, 'sink:income_tax'), amount: tax },
    ],
  });
  await tx.query('INSERT INTO owner_payouts (company_id, kind, day, gross_cents, tax_cents) VALUES ($1, $2, $3, $4, $5)', [companyId, kind, day, grossCents, tax]);
  return { grossCents, taxCents: tax, netCents: grossCents - tax };
}

export async function setSalary(tx: Tx, companyId: string, cents: number) {
  if (!Number.isInteger(cents) || cents < 0) throw badRequest('Salary must be zero or a positive amount.');
  const limits = await payoutLimits(tx, companyId);
  if (cents > limits.salaryCapCents) {
    throw conflict('salary_cap', `The most you can pay yourself is ${(limits.salaryCapCents / 100).toLocaleString('en-US')} CR a day (15% of your 7-day average operating profit).`);
  }
  await tx.query('UPDATE companies SET salary_cents = $2 WHERE id = $1', [companyId, cents]);
  return { salaryCents: cents };
}

export async function declareDividend(tx: Tx, companyId: string, cents: number) {
  await tx.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!Number.isInteger(cents) || cents <= 0) throw badRequest('Dividend must be a positive amount.');
  const limits = await payoutLimits(tx, companyId);
  if (limits.blocked) throw conflict('delinquent', limits.blocked);
  if (cents > limits.dividendAvailableCents) throw conflict('dividend_limit', 'That is more than the company has earned and can spare.');
  return payOwner(tx, companyId, 'dividend', cents, gameDay());
}

export async function ownerWithdrawal(tx: Tx, companyId: string, cents: number) {
  await tx.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!Number.isInteger(cents) || cents <= 0) throw badRequest('Withdrawal must be a positive amount.');
  const limits = await payoutLimits(tx, companyId);
  if (limits.blocked) throw conflict('delinquent', limits.blocked);
  if (cents > limits.withdrawableCents) throw conflict('withdrawal_limit', 'The company must keep 7 days of upkeep and debt payments in cash.');
  return payOwner(tx, companyId, 'withdrawal', cents, gameDay());
}

/**
 * Daily close: pays the standing salary (capped, and only from cash above the reserve), then charges item
 * upkeep from the wallet. Items whose upkeep can't be paid go into storage instead of being seized.
 */
export async function closeOwnerDay(tx: Tx, companyId: string, day: number) {
  const c = (await tx.query<{ salary_cents: number; is_npc: boolean }>('SELECT salary_cents, is_npc FROM companies WHERE id = $1', [companyId])).rows[0];
  let salaryPaid = 0;
  if (!c.is_npc && Number(c.salary_cents) > 0) {
    const limits = await payoutLimits(tx, companyId, day);
    const amount = limits.blocked ? 0 : Math.min(Number(c.salary_cents), limits.salaryCapCents, limits.withdrawableCents);
    if (amount > 0) salaryPaid = (await payOwner(tx, companyId, 'salary', amount, day)).grossCents;
  }

  const items = await tx.query<{ id: string; item_id: string }>('SELECT id, item_id FROM personal_items WHERE company_id = $1 ORDER BY price_cents', [companyId]);
  const wallet = await companyAccount(tx, companyId, 'wallet');
  const sink = await systemAccount(tx, 'sink:item_upkeep');
  let upkeepPaid = 0;
  for (const row of items.rows) {
    const item = itemById(row.item_id);
    const due = item ? toCents(itemUpkeep(item)) : 0;
    if (due <= 0) continue;
    const bal = Number((await tx.query<{ balance_cents: number }>('SELECT balance_cents FROM accounts WHERE id = $1', [wallet])).rows[0].balance_cents);
    if (bal >= due) {
      await transfer(tx, 'item_upkeep', `Upkeep: ${item!.name}`, wallet, sink, due);
      await tx.query('UPDATE personal_items SET stored = false WHERE id = $1', [row.id]);
      upkeepPaid += due;
    } else {
      await tx.query('UPDATE personal_items SET stored = true WHERE id = $1', [row.id]);
    }
  }
  return { salaryPaid, upkeepPaid };
}

export async function buyItem(tx: Tx, companyId: string, itemId: string) {
  const item = itemById(itemId);
  if (!item) throw notFound('Item');
  if (item.price === null) throw conflict('auction_only', `${item.name} is sold only at auction.`);
  if (item.price === 0) throw conflict('free_item', `${item.name} is already yours.`);
  await tx.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  const owned = new Set((await tx.query<{ item_id: string }>('SELECT item_id FROM personal_items WHERE company_id = $1', [companyId])).rows.map((r) => r.item_id));
  if (owned.has(item.id)) throw conflict('owned', `You already own ${item.name}.`);
  const prev = LADDERS.find((l) => l.id === item.ladderId)!.items[item.rung - 1];
  if (prev && prev.price !== 0 && !owned.has(prev.id)) throw conflict('ladder', `Buy ${prev.name} first.`);

  const price = toCents(item.price);
  await transfer(tx, 'luxury_purchase', `Bought ${item.name}`, await companyAccount(tx, companyId, 'wallet'), await systemAccount(tx, 'npc:luxury_shop'), price);
  await tx.query('INSERT INTO personal_items (company_id, item_id, price_cents) VALUES ($1, $2, $3)', [companyId, item.id, price]);
  return { itemId: item.id, priceCents: price };
}

/** Sells an item back to the NPC shop at the category's buyback rate. */
export async function sellItem(tx: Tx, companyId: string, itemId: string) {
  const item = itemById(itemId);
  if (!item) throw notFound('Item');
  const row = (await tx.query<{ id: string; price_cents: number }>('DELETE FROM personal_items WHERE company_id = $1 AND item_id = $2 RETURNING id, price_cents', [companyId, itemId])).rows[0];
  if (!row) throw notFound('Item');
  const proceeds = Math.round(Number(row.price_cents) * CATEGORY_RULES[item.category].buyback);
  await transfer(tx, 'luxury_sale', `Sold ${item.name} back to the shop`, await systemAccount(tx, 'npc:luxury_shop'), await companyAccount(tx, companyId, 'wallet'), proceeds);
  return { itemId, proceedsCents: proceeds };
}

export async function walletCents(q: Q, companyId: string): Promise<number> {
  const res = await q.query<{ balance_cents: number }>("SELECT balance_cents FROM accounts WHERE company_id = $1 AND kind = 'wallet'", [companyId]);
  return Number(res.rows[0]?.balance_cents ?? 0);
}

export async function wealthView(db: Db, companyId: string) {
  const day = gameDay();
  const [wallet, salary, limits, inflows, items, trophies, payouts] = await Promise.all([
    walletCents(db, companyId),
    db.query<{ salary_cents: number }>('SELECT salary_cents FROM companies WHERE id = $1', [companyId]),
    payoutLimits(db, companyId, day),
    inflows30d(db, companyId, day),
    db.query<{ item_id: string; price_cents: number; stored: boolean; bought_at: Date }>(
      'SELECT item_id, price_cents, stored, bought_at FROM personal_items WHERE company_id = $1',
      [companyId],
    ),
    db.query<{ kind: string; title: string }>('SELECT kind, title FROM trophies WHERE company_id = $1 ORDER BY id DESC', [companyId]),
    db.query<{ kind: PayoutKind; gross_cents: number; tax_cents: number; created_at: Date }>(
      'SELECT kind, gross_cents, tax_cents, created_at FROM owner_payouts WHERE company_id = $1 ORDER BY id DESC LIMIT 8',
      [companyId],
    ),
  ]);
  const displayed = items.rows.filter((r) => !r.stored).map((r) => itemById(r.item_id)).filter((i) => i !== undefined);
  // Starter rungs (price 0) count as owned for everyone.
  const freebies = ALL_ITEMS.filter((i) => i.price === 0);
  const upkeepCents = items.rows.reduce((s, r) => {
    const item = itemById(r.item_id);
    return s + (item ? toCents(itemUpkeep(item)) : 0);
  }, 0);
  return {
    walletCents: wallet,
    salaryCents: Number(salary.rows[0].salary_cents),
    limits,
    inflows30dCents: inflows,
    prestige: prestigeScore(displayed, trophies.rows.length),
    upkeepPerDayCents: upkeepCents,
    owned: [
      ...freebies.map((i) => ({ itemId: i.id, priceCents: 0, stored: false, boughtAt: null as string | null })),
      ...items.rows.map((r) => ({ itemId: r.item_id, priceCents: Number(r.price_cents), stored: r.stored, boughtAt: r.bought_at.toISOString() })),
    ],
    trophies: trophies.rows,
    payouts: payouts.rows.map((p) => ({ kind: p.kind, grossCents: Number(p.gross_cents), taxCents: Number(p.tax_cents), at: p.created_at.toISOString() })),
  };
}

const REVENUE_KINDS = ['npc_sale', 'trade_settlement', 'contract_settlement'];
const COST_KINDS = ['op_cost', 'upkeep', 'npc_purchase', 'order_lock', 'order_refund', 'order_cancel', 'contract_funding', 'contract_refund', 'contract_penalty'];

/**
 * Revenue and operating costs on the cash account for each of the last `days` game days (today included).
 * Buying on the exchange or under contract counts as a cost net of refunds.
 */
export async function cashflowHistory(db: Db, companyId: string, days = 7) {
  const today = gameDay();
  const first = today - days + 1;
  const res = await db.query<{ day: number; revenue: number; costs: number }>(
    `SELECT floor(extract(epoch FROM t.created_at) * 1000 * $3 / 86400000)::int AS day,
            COALESCE(SUM(e.amount_cents) FILTER (WHERE t.kind = ANY($4) AND e.amount_cents > 0), 0)::bigint AS revenue,
            COALESCE(-SUM(e.amount_cents) FILTER (WHERE t.kind = ANY($5)), 0)::bigint AS costs
     FROM ledger_entries e JOIN ledger_txns t ON t.id = e.txn_id JOIN accounts a ON a.id = e.account_id
     WHERE a.company_id = $1 AND a.kind = 'cash' AND t.created_at >= $2
     GROUP BY 1`,
    [companyId, gameDayStart(first), config.timeScale, REVENUE_KINDS, COST_KINDS],
  );
  return Array.from({ length: days }, (_, i) => {
    const day = first + i;
    const row = res.rows.find((r) => r.day === day);
    return { day, revenueCents: Number(row?.revenue ?? 0), costsCents: Math.max(0, Number(row?.costs ?? 0)) };
  });
}
