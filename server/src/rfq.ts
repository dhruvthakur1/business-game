import { bondCents, RFQ_RULES, type ContractTerms } from '../../shared/contracts';
import { activate, assertCanContract, lockContract, reliability, validateTerms } from './contracts';
import type { Db, Tx } from './db';
import { badRequest, conflict, notFound } from './errors';
import { gameHoursMs } from './time';

export interface RfqInput {
  productId: string;
  qty: number;
  minQuality: number;
  maxPriceCents: number;
  frequencyHours: number;
  windowHours: number;
  termDays: number;
  minReliability: number;
}

interface RfqRow {
  id: string;
  buyer_id: string;
  product_id: string;
  qty: number;
  min_quality: number;
  max_price_cents: number;
  frequency_hours: number;
  window_hours: number;
  term_days: number;
  min_reliability: string;
  closes_at: Date;
  status: 'open' | 'awarded' | 'expired' | 'cancelled';
}

const termsFor = (r: Pick<RfqRow, 'product_id' | 'qty' | 'min_quality' | 'frequency_hours' | 'window_hours' | 'term_days'>, priceCents: number): ContractTerms => ({
  productId: r.product_id,
  qty: r.qty,
  minQuality: r.min_quality,
  priceCents,
  frequencyHours: r.frequency_hours,
  windowHours: r.window_hours,
  termDays: r.term_days,
});

export async function postRfq(tx: Tx, buyerId: string, input: RfqInput, now = new Date()) {
  await assertCanContract(tx, buyerId, now);
  if (input.minReliability < 0 || input.minReliability > 100) throw badRequest('Minimum reliability must be 0–100.');
  await validateTerms(tx, {
    productId: input.productId, qty: input.qty, minQuality: input.minQuality, priceCents: input.maxPriceCents,
    frequencyHours: input.frequencyHours, windowHours: input.windowHours, termDays: input.termDays,
  });
  const res = await tx.query<{ id: string }>(
    `INSERT INTO rfqs (buyer_id, product_id, qty, min_quality, max_price_cents, frequency_hours, window_hours, term_days, min_reliability, closes_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [buyerId, input.productId, input.qty, input.minQuality, input.maxPriceCents, input.frequencyHours, input.windowHours, input.termDays,
      input.minReliability, new Date(now.getTime() + gameHoursMs(RFQ_RULES.biddingHours)), now],
  );
  return { rfqId: res.rows[0].id };
}

async function lockRfq(tx: Tx, id: string): Promise<RfqRow> {
  const res = await tx.query<RfqRow>('SELECT * FROM rfqs WHERE id = $1 FOR UPDATE', [id]);
  if (!res.rows[0]) throw notFound('RFQ');
  return res.rows[0];
}

/** Places or updates a sealed bid while bidding is open. */
export async function placeBid(tx: Tx, sellerId: string, rfqId: string, priceCents: number, now = new Date()) {
  const r = await lockRfq(tx, rfqId);
  if (r.buyer_id === sellerId) throw badRequest('You cannot bid on your own request.');
  if (r.status !== 'open' || r.closes_at <= now) throw conflict('closed', 'Bidding on this request has closed.');
  if (!Number.isInteger(priceCents) || priceCents <= 0 || priceCents > r.max_price_cents) {
    throw badRequest(`Your price must be at most ${(r.max_price_cents / 100).toFixed(2)} CR.`);
  }
  await assertCanContract(tx, sellerId, now);
  await validateTerms(tx, termsFor(r, priceCents));
  const rel = await reliability(tx, sellerId);
  if (rel.score < Number(r.min_reliability)) throw conflict('reliability', `This buyer needs reliability ${r.min_reliability}; yours is ${rel.score}.`);
  const res = await tx.query<{ id: string }>(
    `INSERT INTO rfq_bids (rfq_id, seller_id, price_cents, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (rfq_id, seller_id) DO UPDATE SET price_cents = EXCLUDED.price_cents, updated_at = EXCLUDED.updated_at RETURNING id`,
    [rfqId, sellerId, priceCents, now],
  );
  return { bidId: res.rows[0].id, bondCents: bondCents(termsFor(r, priceCents)) };
}

/** After bidding closes, the buyer picks a bid. The contract starts at once with the seller's bond. */
export async function awardRfq(tx: Tx, buyerId: string, rfqId: string, bidId: string, now = new Date()) {
  const r = await lockRfq(tx, rfqId);
  if (r.buyer_id !== buyerId) throw notFound('RFQ');
  if (r.status !== 'open') throw conflict('not_open', 'This request is no longer open.');
  if (r.closes_at > now) throw conflict('sealed', 'Bids stay sealed until the bidding window closes.');
  const bid = await tx.query<{ id: string; seller_id: string; price_cents: number }>('SELECT id, seller_id, price_cents FROM rfq_bids WHERE id = $1 AND rfq_id = $2', [bidId, rfqId]);
  if (!bid.rows[0]) throw notFound('Bid');
  const b = bid.rows[0];
  const t = termsFor(r, b.price_cents);
  const created = await tx.query<{ id: string }>(
    `INSERT INTO contracts (buyer_id, seller_id, proposer_id, product_id, qty, min_quality, price_cents, frequency_hours, window_hours,
                            term_days, status, bond_cents, rfq_id, created_at)
     VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8, $9, 'offered', $10, $11, $12) RETURNING id`,
    [buyerId, b.seller_id, t.productId, t.qty, t.minQuality, t.priceCents, t.frequencyHours, t.windowHours, t.termDays, bondCents(t), rfqId, now],
  );
  const contract = await lockContract(tx, created.rows[0].id);
  await activate(tx, contract, now);
  await tx.query("UPDATE rfqs SET status = 'awarded', contract_id = $2 WHERE id = $1", [rfqId, contract.id]);
  return { contractId: contract.id };
}

export async function cancelRfq(tx: Tx, buyerId: string, rfqId: string) {
  const r = await lockRfq(tx, rfqId);
  if (r.buyer_id !== buyerId) throw notFound('RFQ');
  if (r.status !== 'open') throw conflict('not_open', 'This request is no longer open.');
  await tx.query("UPDATE rfqs SET status = 'cancelled' WHERE id = $1", [rfqId]);
  return { rfqId };
}

export async function expireRfqs(db: Db | Tx, now = new Date()) {
  await db.query("UPDATE rfqs SET status = 'expired' WHERE status = 'open' AND closes_at + $2 * interval '1 millisecond' < $1", [now, gameHoursMs(RFQ_RULES.awardHours)]);
}

/** The board as seen by one company: others' open requests (with its own bid), and its own requests. */
export async function rfqBoard(db: Db, companyId: string, now = new Date()) {
  const open = await db.query(
    `SELECT r.*, c.name AS buyer_name, c.region AS buyer_region,
            (SELECT COUNT(*)::int FROM rfq_bids b WHERE b.rfq_id = r.id) AS bids,
            mb.price_cents AS my_bid_cents
     FROM rfqs r JOIN companies c ON c.id = r.buyer_id
     LEFT JOIN rfq_bids mb ON mb.rfq_id = r.id AND mb.seller_id = $1
     WHERE r.status = 'open' AND r.closes_at > $2 AND r.buyer_id <> $1
     ORDER BY r.closes_at LIMIT 50`,
    [companyId, now],
  );
  const mine = await db.query(
    `SELECT r.*, (SELECT COUNT(*)::int FROM rfq_bids b WHERE b.rfq_id = r.id) AS bids
     FROM rfqs r WHERE r.buyer_id = $1 AND (r.status = 'open' OR r.created_at > $2::timestamptz - interval '7 days')
     ORDER BY r.created_at DESC LIMIT 20`,
    [companyId, now],
  );
  const mineIds = mine.rows.filter((r) => r.closes_at <= now).map((r) => r.id);
  const bids = mineIds.length
    ? await db.query(
        `SELECT b.id, b.rfq_id, b.price_cents, b.seller_id, c.name AS seller_name FROM rfq_bids b JOIN companies c ON c.id = b.seller_id
         WHERE b.rfq_id = ANY($1::uuid[]) ORDER BY b.price_cents, b.updated_at`,
        [mineIds],
      )
    : { rows: [] as { id: string; rfq_id: string; price_cents: number; seller_id: string; seller_name: string }[] };
  const relCache = new Map<string, number>();
  const rel = async (id: string) => {
    if (!relCache.has(id)) relCache.set(id, (await reliability(db, id)).score);
    return relCache.get(id)!;
  };

  const shape = (r: Record<string, unknown>) => ({
    id: r.id as string,
    productId: r.product_id as string,
    qty: r.qty as number,
    minQuality: r.min_quality as number,
    maxPriceCents: Number(r.max_price_cents),
    frequencyHours: r.frequency_hours as number,
    windowHours: r.window_hours as number,
    termDays: r.term_days as number,
    minReliability: Number(r.min_reliability),
    closesAt: (r.closes_at as Date).toISOString(),
    status: r.status as string,
    bids: r.bids as number,
    contractId: (r.contract_id as string | null) ?? null,
  });
  return {
    open: open.rows.map((r) => ({ ...shape(r), buyerName: r.buyer_name as string, buyerRegion: r.buyer_region as string, myBidCents: r.my_bid_cents === null ? null : Number(r.my_bid_cents) })),
    mine: await Promise.all(
      mine.rows.map(async (r) => ({
        ...shape(r),
        sealed: (r.closes_at as Date) > now,
        bidList: await Promise.all(
          bids.rows
            .filter((b) => b.rfq_id === r.id)
            .map(async (b) => ({ id: b.id, priceCents: Number(b.price_cents), sellerId: b.seller_id, sellerName: b.seller_name, reliability: await rel(b.seller_id) })),
        ),
      })),
    ),
  };
}
