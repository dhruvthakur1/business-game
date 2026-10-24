import { PRICE_BAND } from '../../shared/catalog';
import { SELLER_FEE } from '../../shared/economy';
import type { Db, Tx } from './db';
import { badRequest, conflict, notFound } from './errors';
import { addGoods, takeGoods } from './inventory';
import { companyAccount, post, systemAccount, transfer } from './ledger';
import { loadProduct } from './catalog';
import { gameDayMs } from './time';
import { awardXp } from './xp';
import { XP_CAPS, XP_PER_CR_TRADE } from '../../shared/levels';

export type Side = 'buy' | 'sell';

export interface PlaceOrderInput {
  productId: string;
  side: Side;
  qty: number;
  priceCents: number;
  /** Sell: quality of the goods offered. Buy: minimum acceptable quality. */
  quality: number;
}

export interface Fill {
  tradeId: number;
  qty: number;
  priceCents: number;
  quality: number;
  feeCents: number;
}

interface OrderRow {
  id: string;
  company_id: string;
  side: Side;
  price_cents: number;
  remaining: number;
  quality: number;
}

const MAX_ORDER_QTY = 1_000_000;
const MAX_FILLS_PER_ORDER = 200;

export const feeFor = (priceCents: number, qty: number) => Math.round(priceCents * qty * SELLER_FEE);

/**
 * Places a limit order and matches it against the book with price-time priority.
 * Trades execute at the resting (maker) order's price. Buyers lock price × qty in escrow up front;
 * sellers move goods out of the warehouse into the order. Self-trades are skipped.
 */
export async function placeOrder(tx: Tx, companyId: string, input: PlaceOrderInput) {
  const { productId, side, qty, priceCents, quality } = input;
  if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_ORDER_QTY) throw badRequest('Quantity must be a whole number between 1 and 1,000,000.');
  if (!Number.isInteger(priceCents) || priceCents <= 0) throw badRequest('Price must be a positive amount in cents.');
  if (!Number.isInteger(quality) || quality < 0 || quality > 5) throw badRequest('Quality must be between 0 and 5.');

  const product = await loadProduct(tx, productId);
  const min = Math.ceil(product.refPriceCents * PRICE_BAND.min);
  const max = Math.floor(product.refPriceCents * PRICE_BAND.max);
  if (priceCents < min || priceCents > max) {
    throw badRequest(`Price must be between ${(min / 100).toFixed(2)} and ${(max / 100).toFixed(2)} CR (0.5×–2× reference).`);
  }

  const cash = await companyAccount(tx, companyId, 'cash');
  const escrow = await companyAccount(tx, companyId, 'escrow');

  const ins = await tx.query<{ id: string }>(
    `INSERT INTO orders (company_id, product_id, side, price_cents, qty, remaining, quality)
     VALUES ($1, $2, $3, $4, $5, $5, $6) RETURNING id`,
    [companyId, productId, side, priceCents, qty, quality],
  );
  const orderId = ins.rows[0].id;

  if (side === 'buy') {
    await transfer(tx, 'order_lock', `Buy order: ${qty} ${product.name}`, cash, escrow, priceCents * qty);
  } else {
    await takeGoods(tx, companyId, productId, quality, qty);
  }

  const opposite = side === 'buy'
    ? await tx.query<OrderRow>(
        `SELECT id, company_id, side, price_cents, remaining, quality FROM orders
         WHERE product_id = $1 AND side = 'sell' AND status = 'open' AND company_id <> $2
           AND price_cents <= $3 AND quality >= $4
         ORDER BY price_cents ASC, seq ASC LIMIT $5 FOR UPDATE`,
        [productId, companyId, priceCents, quality, MAX_FILLS_PER_ORDER],
      )
    : await tx.query<OrderRow>(
        `SELECT id, company_id, side, price_cents, remaining, quality FROM orders
         WHERE product_id = $1 AND side = 'buy' AND status = 'open' AND company_id <> $2
           AND price_cents >= $3 AND quality <= $4
         ORDER BY price_cents DESC, seq ASC LIMIT $5 FOR UPDATE`,
        [productId, companyId, priceCents, quality, MAX_FILLS_PER_ORDER],
      );

  const feeSink = await systemAccount(tx, 'sink:exchange_fees');
  const fills: Fill[] = [];
  let remaining = qty;

  for (const maker of opposite.rows) {
    if (remaining === 0) break;
    const fillQty = Math.min(remaining, maker.remaining);
    const price = maker.price_cents;
    const buyerId = side === 'buy' ? companyId : maker.company_id;
    const sellerId = side === 'sell' ? companyId : maker.company_id;
    const goodsQuality = side === 'buy' ? maker.quality : quality;
    const gross = price * fillQty;
    const fee = feeFor(price, fillQty);

    const buyerEscrow = side === 'buy' ? escrow : await companyAccount(tx, buyerId, 'escrow');
    const buyerCash = side === 'buy' ? cash : await companyAccount(tx, buyerId, 'cash');
    const sellerCash = side === 'sell' ? cash : await companyAccount(tx, sellerId, 'cash');
    // A taker buyer locked its own limit price; refund the improvement over the maker's price.
    const lockedPrice = side === 'buy' ? priceCents : price;
    const refund = (lockedPrice - price) * fillQty;

    const trade = await tx.query<{ id: number }>(
      `INSERT INTO trades (product_id, buy_order_id, sell_order_id, buyer_id, seller_id, price_cents, qty, quality, fee_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [productId, side === 'buy' ? orderId : maker.id, side === 'sell' ? orderId : maker.id, buyerId, sellerId, price, fillQty, goodsQuality, fee],
    );
    const tradeId = trade.rows[0].id;

    await post(tx, {
      kind: 'trade_settlement',
      memo: `${fillQty} ${product.name} @ ${(price / 100).toFixed(2)}`,
      idempotencyKey: `trade:${tradeId}`,
      entries: [
        { accountId: buyerEscrow, amount: -(gross + refund) },
        { accountId: sellerCash, amount: gross - fee },
        { accountId: feeSink, amount: fee },
        ...(refund > 0 ? [{ accountId: buyerCash, amount: refund }] : []),
      ],
    });
    await addGoods(tx, buyerId, productId, goodsQuality, fillQty);
    await tx.query(
      `UPDATE orders SET remaining = remaining - $2, status = CASE WHEN remaining - $2 = 0 THEN 'filled' ELSE status END WHERE id = $1`,
      [maker.id, fillQty],
    );
    remaining -= fillQty;
    fills.push({ tradeId, qty: fillQty, priceCents: price, quality: goodsQuality, feeCents: fee });
    for (const who of [buyerId, sellerId]) {
      await awardXp(tx, who, 'trade', (gross / 100) * XP_PER_CR_TRADE, { note: `Traded ${fillQty} ${product.name}`, capKey: 'market', dailyCap: XP_CAPS.market });
    }
  }

  await tx.query(
    `UPDATE orders SET remaining = $2, status = CASE WHEN $2::bigint = 0 THEN 'filled' ELSE 'open' END WHERE id = $1`,
    [orderId, remaining],
  );
  return { orderId, status: remaining === 0 ? 'filled' : 'open', remaining, fills };
}

export async function cancelOrder(tx: Tx, companyId: string, orderId: string) {
  const res = await tx.query<OrderRow & { product_id: string; status: string }>(
    `SELECT id, company_id, side, price_cents, remaining, quality, product_id, status FROM orders
     WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [orderId, companyId],
  );
  const o = res.rows[0];
  if (!o) throw notFound('Order');
  if (o.status !== 'open') throw conflict('not_open', 'Only open orders can be cancelled.');

  await tx.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderId]);
  if (o.side === 'buy') {
    const cash = await companyAccount(tx, companyId, 'cash');
    const escrow = await companyAccount(tx, companyId, 'escrow');
    await transfer(tx, 'order_cancel', 'Cancelled buy order', escrow, cash, o.price_cents * o.remaining, `cancel:${orderId}`);
  } else {
    await addGoods(tx, companyId, o.product_id, o.quality, o.remaining);
  }
  return { orderId, refundedQty: o.remaining };
}

export async function orderBook(db: Db, productId: string, depth = 8) {
  const levels = async (side: Side) => {
    const res = await db.query<{ price_cents: number; quality: number; qty: number; orders: number }>(
      `SELECT price_cents, quality, SUM(remaining)::bigint AS qty, COUNT(*)::int AS orders FROM orders
       WHERE product_id = $1 AND side = $2 AND status = 'open'
       GROUP BY price_cents, quality
       ORDER BY price_cents ${side === 'buy' ? 'DESC' : 'ASC'}, quality DESC LIMIT $3`,
      [productId, side, depth],
    );
    return res.rows.map((r) => ({ priceCents: r.price_cents, quality: r.quality, qty: r.qty, orders: r.orders }));
  };
  return { bids: await levels('buy'), asks: await levels('sell') };
}

export async function marketSummary(db: Db) {
  const since = new Date(Date.now() - gameDayMs());
  const res = await db.query(
    `SELECT p.id, p.name, p.tier, p.npc_vendor, COALESCE(r.price_cents, p.ref_price_cents) AS ref,
       (SELECT price_cents FROM trades t WHERE t.product_id = p.id ORDER BY id DESC LIMIT 1) AS last,
       (SELECT price_cents FROM trades t WHERE t.product_id = p.id AND t.created_at < $1 ORDER BY id DESC LIMIT 1) AS prev,
       (SELECT COALESCE(SUM(qty), 0) FROM trades t WHERE t.product_id = p.id AND t.created_at >= $1)::bigint AS volume,
       (SELECT MAX(price_cents) FROM orders o WHERE o.product_id = p.id AND o.side = 'buy' AND o.status = 'open') AS best_bid,
       (SELECT MIN(price_cents) FROM orders o WHERE o.product_id = p.id AND o.side = 'sell' AND o.status = 'open') AS best_ask
     FROM products p LEFT JOIN reference_prices r ON r.product_id = p.id
     ORDER BY p.tier, p.name`,
    [since],
  );
  return res.rows.map((r) => {
    const last = r.last ?? r.ref;
    const base = r.prev ?? r.ref;
    return {
      productId: r.id as string,
      name: r.name as string,
      tier: r.tier as string,
      npcVendor: r.npc_vendor as boolean,
      refPriceCents: r.ref as number,
      lastPriceCents: last as number,
      change24h: base ? ((last - base) / base) * 100 : 0,
      volume24h: Number(r.volume),
      bestBidCents: r.best_bid as number | null,
      bestAskCents: r.best_ask as number | null,
    };
  });
}

/** Daily closing prices for the last `days` game days (carrying the previous close forward). */
export async function priceHistory(db: Db, productId: string, days = 7) {
  const product = await loadProduct(db, productId);
  const dayMs = gameDayMs();
  const start = Date.now() - days * dayMs;
  const trades = await db.query<{ price_cents: number; created_at: Date }>(
    'SELECT price_cents, created_at FROM trades WHERE product_id = $1 AND created_at >= $2 ORDER BY id',
    [productId, new Date(start)],
  );
  const closes: number[] = [];
  let last = product.refPriceCents;
  for (let d = 0; d < days; d++) {
    const end = start + (d + 1) * dayMs;
    for (const t of trades.rows) if (t.created_at.getTime() < end) last = t.price_cents;
    closes.push(last);
  }
  return closes;
}

/**
 * Moves each reference price toward its 7-day volume-weighted average, at most ±10% per call.
 * The server runs this once per game day.
 */
export async function refreshReferencePrices(db: Db) {
  const since = new Date(Date.now() - 7 * gameDayMs());
  await db.query(
    `INSERT INTO reference_prices (product_id, price_cents, updated_at)
     SELECT p.id,
            ROUND(GREATEST(LEAST(v.vwap, COALESCE(r.price_cents, p.ref_price_cents) * 1.1), COALESCE(r.price_cents, p.ref_price_cents) * 0.9))::bigint,
            now()
     FROM products p
     LEFT JOIN reference_prices r ON r.product_id = p.id
     JOIN LATERAL (SELECT ROUND(SUM(price_cents * qty)::numeric / NULLIF(SUM(qty), 0)) AS vwap
                   FROM trades t WHERE t.product_id = p.id AND t.created_at >= $1) v ON v.vwap IS NOT NULL
     ON CONFLICT (product_id) DO UPDATE SET price_cents = EXCLUDED.price_cents, updated_at = now()`,
    [since],
  );
}

export async function myOrders(db: Db, companyId: string) {
  const res = await db.query(
    `SELECT o.id, o.product_id, o.side, o.price_cents, o.qty, o.remaining, o.quality, o.created_at
     FROM orders o WHERE o.company_id = $1 AND o.status = 'open' ORDER BY o.created_at DESC LIMIT 50`,
    [companyId],
  );
  return res.rows.map((r) => ({
    id: r.id as string,
    productId: r.product_id as string,
    side: r.side as Side,
    priceCents: r.price_cents as number,
    qty: r.qty as number,
    remaining: r.remaining as number,
    quality: r.quality as number,
    createdAt: (r.created_at as Date).toISOString(),
  }));
}
