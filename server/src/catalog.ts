import type { Tx } from './db';
import { badRequest, notFound } from './errors';

type Q = Pick<Tx, 'query'>;

export interface BuildingTypeRow {
  id: string;
  name: string;
  buildCostCents: number;
  unlockLevel: number;
  cycleMinutes: number;
  opCostCents: number;
  inputs: { productId: string; qty: number }[];
  outputs: { productId: string; qty: number }[];
}

export async function loadBuildingType(q: Q, id: string): Promise<BuildingTypeRow> {
  const t = await q.query(
    'SELECT id, name, build_cost_cents, unlock_level, cycle_minutes, op_cost_cents FROM building_types WHERE id = $1',
    [id],
  );
  if (!t.rows[0]) throw notFound('Building type');
  const lines = await q.query<{ product_id: string; direction: 'in' | 'out'; qty: number }>(
    'SELECT product_id, direction, qty FROM recipe_lines WHERE building_type_id = $1 ORDER BY direction, qty DESC, product_id',
    [id],
  );
  const row = t.rows[0];
  return {
    id: row.id,
    name: row.name,
    buildCostCents: row.build_cost_cents,
    unlockLevel: row.unlock_level,
    cycleMinutes: row.cycle_minutes,
    opCostCents: row.op_cost_cents,
    inputs: lines.rows.filter((l) => l.direction === 'in').map((l) => ({ productId: l.product_id, qty: l.qty })),
    outputs: lines.rows.filter((l) => l.direction === 'out').map((l) => ({ productId: l.product_id, qty: l.qty })),
  };
}

export interface ProductRow {
  id: string;
  name: string;
  tier: string;
  basePriceCents: number;
  refPriceCents: number;
  npcVendor: boolean;
}

export async function loadProduct(q: Q, id: string): Promise<ProductRow> {
  const res = await q.query(
    `SELECT p.id, p.name, p.tier, p.ref_price_cents, p.npc_vendor, COALESCE(r.price_cents, p.ref_price_cents) AS ref
     FROM products p LEFT JOIN reference_prices r ON r.product_id = p.id WHERE p.id = $1`,
    [id],
  );
  const p = res.rows[0];
  if (!p) throw badRequest(`Unknown product ${id}`);
  return { id: p.id, name: p.name, tier: p.tier, basePriceCents: p.ref_price_cents, refPriceCents: p.ref, npcVendor: p.npc_vendor };
}
