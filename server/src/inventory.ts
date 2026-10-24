import type { Tx } from './db';
import { conflict } from './errors';

export async function addGoods(tx: Tx, companyId: string, productId: string, quality: number, qty: number) {
  if (qty <= 0) return;
  await tx.query(
    `INSERT INTO inventory (company_id, product_id, quality, qty) VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, product_id, quality) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty`,
    [companyId, productId, quality, qty],
  );
}

export async function takeGoods(tx: Tx, companyId: string, productId: string, quality: number, qty: number) {
  const res = await tx.query(
    `UPDATE inventory SET qty = qty - $4
     WHERE company_id = $1 AND product_id = $2 AND quality = $3 AND qty >= $4`,
    [companyId, productId, quality, qty],
  );
  if (res.rowCount === 0) {
    throw conflict('insufficient_goods', `Not enough ${productId.replace('_', ' ')} (Q${quality}) in the warehouse.`);
  }
}

/** Highest-quality lot with at least `qty` units, or null. */
export async function bestLot(tx: Tx, companyId: string, productId: string, qty: number): Promise<number | null> {
  const res = await tx.query<{ quality: number }>(
    `SELECT quality FROM inventory WHERE company_id = $1 AND product_id = $2 AND qty >= $3
     ORDER BY quality DESC LIMIT 1`,
    [companyId, productId, qty],
  );
  return res.rows[0]?.quality ?? null;
}

export interface InventoryLot {
  productId: string;
  quality: number;
  qty: number;
}

export async function listInventory(tx: Pick<Tx, 'query'>, companyId: string): Promise<InventoryLot[]> {
  const res = await tx.query<{ product_id: string; quality: number; qty: number }>(
    'SELECT product_id, quality, qty FROM inventory WHERE company_id = $1 AND qty > 0 ORDER BY product_id, quality',
    [companyId],
  );
  return res.rows.map((r) => ({ productId: r.product_id, quality: r.quality, qty: r.qty }));
}
