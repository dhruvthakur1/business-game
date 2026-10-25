import { freightCost, transitHours } from '../../shared/regions';
import { type Db, type Tx, withTx } from './db';
import { addGoods } from './inventory';
import { gameHoursMs } from './time';

type Q = Pick<Tx, 'query'>;

export interface FreightQuote {
  fromRegion: string;
  toRegion: string;
  freightCents: number;
  /** 0 for weightless goods, which arrive immediately. */
  transitMs: number;
}

/** Freight and transit for moving `qty` of a product from one company's region to another's. */
export async function quoteFreight(q: Q, fromCompany: string, toCompany: string, productId: string, qty: number): Promise<FreightQuote> {
  const res = await q.query<{ from_region: string; to_region: string; weight: string }>(
    `SELECT (SELECT region FROM companies WHERE id = $1) AS from_region, (SELECT region FROM companies WHERE id = $2) AS to_region,
            (SELECT unit_weight FROM products WHERE id = $3) AS weight`,
    [fromCompany, toCompany, productId],
  );
  const r = res.rows[0];
  const weight = Number(r.weight ?? 1);
  return {
    fromRegion: r.from_region,
    toRegion: r.to_region,
    freightCents: Math.round(freightCost(qty, weight, r.from_region, r.to_region) * 100),
    transitMs: gameHoursMs(transitHours(weight, r.from_region, r.to_region)),
  };
}

/**
 * Sends goods to a company. Weightless goods go straight into the warehouse; everything else travels as a
 * shipment that lands when it arrives. Freight is charged by the caller (it belongs in the sale's ledger post).
 */
export async function ship(
  tx: Tx,
  input: { to: string; from: string; productId: string; quality: number; qty: number; source: 'trade' | 'contract'; sourceRef: string; quote: FreightQuote },
): Promise<{ arrivesAt: Date; inTransit: boolean }> {
  const now = new Date();
  if (input.quote.transitMs <= 0) {
    await addGoods(tx, input.to, input.productId, input.quality, input.qty);
    return { arrivesAt: now, inTransit: false };
  }
  const arrivesAt = new Date(now.getTime() + input.quote.transitMs);
  await tx.query(
    `INSERT INTO shipments (company_id, from_company, product_id, quality, qty, from_region, to_region, freight_cents, source, source_ref, shipped_at, arrives_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [input.to, input.from, input.productId, input.quality, input.qty, input.quote.fromRegion, input.quote.toRegion, input.quote.freightCents, input.source, input.sourceRef, now, arrivesAt],
  );
  return { arrivesAt, inTransit: true };
}

/** Lands every shipment that has arrived (exactly once each). Optionally only one company's. */
export async function deliverShipments(db: Db, opts: { companyId?: string; now?: Date } = {}): Promise<number> {
  return withTx(db, async (tx) => {
    const res = await tx.query<{ company_id: string; product_id: string; quality: number; qty: number }>(
      `UPDATE shipments SET delivered_at = $1
       WHERE delivered_at IS NULL AND arrives_at <= $1 AND ($2::uuid IS NULL OR company_id = $2)
       RETURNING company_id, product_id, quality, qty`,
      [opts.now ?? new Date(), opts.companyId ?? null],
    );
    for (const s of res.rows) await addGoods(tx, s.company_id, s.product_id, s.quality, Number(s.qty));
    return res.rowCount ?? 0;
  });
}

/** A company's incoming shipments, soonest first. */
export async function incomingShipments(q: Q, companyId: string) {
  const res = await q.query<{ id: number; product_id: string; quality: number; qty: number; from_region: string; source: string; arrives_at: Date; seller: string | null }>(
    `SELECT s.id, s.product_id, s.quality, s.qty, s.from_region, s.source, s.arrives_at, c.name AS seller
     FROM shipments s LEFT JOIN companies c ON c.id = s.from_company
     WHERE s.company_id = $1 AND s.delivered_at IS NULL ORDER BY s.arrives_at LIMIT 50`,
    [companyId],
  );
  return res.rows.map((s) => ({
    id: Number(s.id), productId: s.product_id, quality: s.quality, qty: Number(s.qty), fromRegion: s.from_region,
    source: s.source, sellerName: s.seller, arrivesAt: s.arrives_at.toISOString(),
  }));
}
