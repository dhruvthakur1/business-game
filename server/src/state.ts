import { config } from './config';
import type { Company } from './companies';
import type { Db, Tx } from './db';
import { listInventory } from './inventory';
import { listBuildings } from './production';
import { gameDayMs } from './time';
import { xpSummary } from './xp';
import { leagueSummary } from './leagues';
import { allDesigns } from './brands';
import { researchPoints } from './research';
import { seasonSummary } from './season';

type Q = Pick<Tx, 'query'>;

/** Cash-account flows from running the business (before debt service). */
export const OPERATING_KINDS = ['op_cost', 'upkeep', 'npc_purchase', 'npc_sale', 'order_lock', 'order_refund', 'order_cancel', 'trade_settlement'];

/** Net operating cash flow on the cash account between two instants. */
export async function operatingFlowCents(q: Q, companyId: string, from: Date, to: Date = new Date()): Promise<number> {
  const res = await q.query<{ total: number }>(
    `SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS total
     FROM ledger_entries e JOIN ledger_txns t ON t.id = e.txn_id JOIN accounts a ON a.id = e.account_id
     WHERE a.company_id = $1 AND a.kind = 'cash' AND t.kind = ANY($2) AND t.created_at >= $3 AND t.created_at < $4`,
    [companyId, OPERATING_KINDS, from, to],
  );
  return Number(res.rows[0].total);
}

/** Positive sales inflows (NPC sales + exchange proceeds) between two instants. */
export async function revenueCents(q: Q, companyId: string, from: Date, to: Date): Promise<number> {
  const res = await q.query<{ total: number }>(
    `SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS total
     FROM ledger_entries e JOIN ledger_txns t ON t.id = e.txn_id JOIN accounts a ON a.id = e.account_id
     WHERE a.company_id = $1 AND a.kind = 'cash' AND e.amount_cents > 0 AND t.kind IN ('npc_sale', 'trade_settlement')
       AND t.created_at >= $2 AND t.created_at < $3`,
    [companyId, from, to],
  );
  return Number(res.rows[0].total);
}

/**
 * Conservative asset value (the owner's personal wallet is not company property): cash + escrow + goods at min(base, reference) price + goods on open sell
 * orders + 70% of what was spent on buildings.
 */
export async function assetsCents(q: Q, companyId: string): Promise<number> {
  const res = await q.query<{ money: number; goods: number; buildings: number; sell_orders: number }>(
    `SELECT
       (SELECT COALESCE(SUM(balance_cents), 0) FROM accounts WHERE company_id = $1 AND kind <> 'wallet')::bigint AS money,
       (SELECT COALESCE(SUM(i.qty * LEAST(p.ref_price_cents, COALESCE(r.price_cents, p.ref_price_cents))), 0)
          FROM inventory i JOIN products p ON p.id = i.product_id LEFT JOIN reference_prices r ON r.product_id = p.id
          WHERE i.company_id = $1)::bigint AS goods,
       (SELECT COALESCE(SUM(bt.build_cost_cents * b.level), 0) FROM buildings b JOIN building_types bt ON bt.id = b.building_type_id
          WHERE b.company_id = $1)::bigint AS buildings,
       (SELECT COALESCE(SUM(o.remaining * p.ref_price_cents), 0) FROM orders o JOIN products p ON p.id = o.product_id
          WHERE o.company_id = $1 AND o.side = 'sell' AND o.status = 'open')::bigint AS sell_orders`,
    [companyId],
  );
  const v = res.rows[0];
  return Number(v.money) + Number(v.goods) + Number(v.sell_orders) + Math.round(0.7 * Number(v.buildings));
}

/** Everything owed: open loan balances and arrears plus unpaid upkeep. */
export async function debtCents(q: Q, companyId: string): Promise<number> {
  const res = await q.query<{ loans: number; upkeep: number }>(
    `SELECT
       (SELECT COALESCE(SUM(outstanding_cents + arrears_cents), 0) FROM loans
          WHERE company_id = $1 AND status NOT IN ('repaid', 'defaulted'))::bigint AS loans,
       (SELECT upkeep_arrears_cents FROM companies WHERE id = $1)::bigint AS upkeep`,
    [companyId],
  );
  return Number(res.rows[0].loans) + Number(res.rows[0].upkeep);
}

/** Everything the client needs to render the company dashboard in one round trip. */
export async function companyState(db: Db, company: Company) {
  const [accounts, inventory, buildings, assets, debt, flow, orders, flags, xp, league, research, designs, season] = await Promise.all([
    db.query<{ kind: string; balance_cents: number }>('SELECT kind, balance_cents FROM accounts WHERE company_id = $1', [company.id]),
    listInventory(db, company.id),
    listBuildings(db, company.id),
    assetsCents(db, company.id),
    debtCents(db, company.id),
    operatingFlowCents(db, company.id, new Date(Date.now() - 7 * gameDayMs())),
    db.query<{ n: number }>("SELECT count(*)::int AS n FROM orders WHERE company_id = $1 AND status = 'open'", [company.id]),
    db.query<{ upkeep_arrears_cents: number }>('SELECT upkeep_arrears_cents FROM companies WHERE id = $1', [company.id]),
    xpSummary(db, company.id),
    leagueSummary(db, company.id),
    researchPoints(db, company.id),
    allDesigns(db),
    seasonSummary(db, company.id),
  ]);
  const bal = (kind: string) => accounts.rows.find((a) => a.kind === kind)?.balance_cents ?? 0;

  return {
    // Level comes from the live row: the session lookup may predate a level-up.
    company: { ...company, level: xp.level },
    xp,
    league,
    season,
    serverTime: new Date().toISOString(),
    timeScale: config.timeScale,
    cashCents: bal('cash'),
    escrowCents: bal('escrow'),
    walletCents: bal('wallet'),
    debtCents: debt,
    upkeepArrearsCents: Number(flags.rows[0].upkeep_arrears_cents),
    netWorthCents: assets - debt,
    operatingCashFlow7dCents: flow,
    openOrders: orders.rows[0].n,
    inventory,
    buildings,
    /** Research points per family (drives the quality bonus preview). */
    research,
    /** Branded products on the server, so any design in the warehouse or market can be named and drawn. */
    designs,
  };
}

export async function activity(db: Db, companyId: string, limit = 20) {
  const res = await db.query(
    `SELECT t.id, t.kind, t.memo, t.created_at, e.amount_cents
     FROM ledger_entries e JOIN ledger_txns t ON t.id = e.txn_id JOIN accounts a ON a.id = e.account_id
     WHERE a.company_id = $1 AND a.kind = 'cash'
     ORDER BY e.id DESC LIMIT $2`,
    [companyId, limit],
  );
  return res.rows.map((r) => ({
    id: r.id as number,
    kind: r.kind as string,
    memo: r.memo as string,
    at: (r.created_at as Date).toISOString(),
    amountCents: r.amount_cents as number,
  }));
}
