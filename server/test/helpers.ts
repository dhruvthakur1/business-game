import { createCompany } from '../src/companies';
import { createPool, type Db, withTx } from '../src/db';
import { addGoods } from '../src/inventory';
import { migrate } from '../src/migrate';
import { upsertCatalog } from '../src/seed';
import { deliverShipments } from '../src/shipping';

let counter = 0;

/** Fresh schema + catalog. Call once per test file. */
export async function freshDb(): Promise<Db> {
  const db = createPool();
  await migrate(db, { reset: true });
  await upsertCatalog(db);
  return db;
}

export async function newCompany(db: Db, opts: { capital?: number; level?: number } = {}) {
  counter += 1;
  const { company, token } = await createCompany(db, {
    name: `Test Co ${Date.now() % 100000}-${counter}`,
    capitalCents: opts.capital ?? 10_000_000,
    level: opts.level ?? 30,
  });
  return { id: company.id, token };
}

export async function cash(db: Db, companyId: string, kind: 'cash' | 'escrow' = 'cash') {
  const r = await db.query<{ balance_cents: number }>('SELECT balance_cents FROM accounts WHERE company_id = $1 AND kind = $2', [companyId, kind]);
  return r.rows[0].balance_cents;
}

export async function goods(db: Db, companyId: string, productId: string, quality: number) {
  const r = await db.query<{ qty: number }>('SELECT qty FROM inventory WHERE company_id = $1 AND product_id = $2 AND quality = $3', [companyId, productId, quality]);
  return r.rows[0]?.qty ?? 0;
}

export async function give(db: Db, companyId: string, productId: string, quality: number, qty: number) {
  await withTx(db, (tx) => addGoods(tx, companyId, productId, quality, qty));
}

/** Lands every shipment as if its transit time had passed. */
export const arriveAll = (db: Db) => deliverShipments(db, { now: new Date(Date.now() + 365 * 86_400_000) });

/** The sum of every account must always be zero in a closed double-entry ledger. */
export async function ledgerTotal(db: Db) {
  const r = await db.query<{ total: number }>('SELECT COALESCE(SUM(balance_cents), 0)::bigint AS total FROM accounts');
  const entries = await db.query<{ total: number }>('SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM ledger_entries');
  return { balances: Number(r.rows[0].total), entries: Number(entries.rows[0].total) };
}
