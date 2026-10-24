import { CONTRACT_RULES } from '../../shared/contracts';
import { acceptContract, rejectContract } from './contracts';
import { type Db, withTx } from './db';
import { GameError } from './errors';
import { awardRfq, placeBid, postRfq } from './rfq';
import { gameHoursMs } from './time';

/**
 * NPC companies (the seeded market makers) act as contract counterparties so a single player can
 * use contracts and the RFQ board. They answer offers, bid on players' RFQs, post RFQs of their own
 * and award them to the cheapest bid once bidding closes.
 */

/** NPCs think it over for a game hour before answering. */
const RESPONSE_DELAY_HOURS = 1;
const OPEN_NPC_RFQS = 4;

const TEMPLATES = [
  { buyer: 'Harbor Bakeries', productId: 'flour', qty: 240, minQuality: 1, frequencyHours: 24, windowHours: 24, termDays: 14, markup: 1.05, minReliability: 0 },
  { buyer: 'Harbor Bakeries', productId: 'wheat', qty: 300, minQuality: 0, frequencyHours: 24, windowHours: 8, termDays: 7, markup: 1.04, minReliability: 0 },
  { buyer: 'Ferro Labs', productId: 'mwh', qty: 20, minQuality: 0, frequencyHours: 24, windowHours: 24, termDays: 10, markup: 1.06, minReliability: 0 },
  { buyer: 'Ferro Labs', productId: 'steel', qty: 120, minQuality: 0, frequencyHours: 168, windowHours: 24, termDays: 28, markup: 1.05, minReliability: 0 },
  { buyer: 'Saltmarsh Foods', productId: 'bread', qty: 120, minQuality: 1, frequencyHours: 24, windowHours: 24, termDays: 7, markup: 1.06, minReliability: 0 },
  { buyer: 'Ridgeback Mining', productId: 'coal', qty: 400, minQuality: 0, frequencyHours: 24, windowHours: 24, termDays: 14, markup: 1.03, minReliability: 0 },
];

async function refPrice(db: Db, productId: string): Promise<number> {
  const r = await db.query<{ ref: number }>(
    'SELECT COALESCE(r.price_cents, p.ref_price_cents) AS ref FROM products p LEFT JOIN reference_prices r ON r.product_id = p.id WHERE p.id = $1',
    [productId],
  );
  return Number(r.rows[0].ref);
}

async function attempt(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof GameError)) throw err;
  }
}

export async function runBots(db: Db, now = new Date()) {
  const npcs = await db.query<{ id: string; name: string }>('SELECT id, name FROM companies WHERE is_npc');
  if (npcs.rowCount === 0) return;
  const npcIds = npcs.rows.map((n) => n.id);
  const think = new Date(now.getTime() - gameHoursMs(RESPONSE_DELAY_HOURS));

  // 1. Answer offers made to NPCs: sell at ≥ 98% of reference, buy at ≤ 103%.
  const offers = await db.query<{ id: string; buyer_id: string; seller_id: string; product_id: string; price_cents: number }>(
    `SELECT id, buyer_id, seller_id, product_id, price_cents FROM contracts
     WHERE status = 'offered' AND created_at <= $2 AND proposer_id <> ALL($1::uuid[])
       AND (buyer_id = ANY($1::uuid[]) OR seller_id = ANY($1::uuid[]))`,
    [npcIds, think],
  );
  for (const o of offers.rows) {
    const npcIsSeller = npcIds.includes(o.seller_id);
    const npc = npcIsSeller ? o.seller_id : o.buyer_id;
    const ref = await refPrice(db, o.product_id);
    const fair = npcIsSeller ? o.price_cents >= ref * 0.98 : o.price_cents <= ref * 1.03;
    await attempt(() => withTx(db, (tx) => (fair ? acceptContract(tx, npc, o.id, now) : rejectContract(tx, npc, o.id))));
  }

  // 2. Bid on players' RFQs at about reference + 1%, if the NPC stocks the product.
  const rfqs = await db.query<{ id: string; buyer_id: string; product_id: string; qty: number; min_quality: number; max_price_cents: number }>(
    `SELECT id, buyer_id, product_id, qty, min_quality, max_price_cents FROM rfqs
     WHERE status = 'open' AND closes_at > $2 AND created_at <= $3 AND buyer_id <> ALL($1::uuid[])`,
    [npcIds, now, think],
  );
  for (const r of rfqs.rows) {
    const ref = await refPrice(db, r.product_id);
    const price = Math.min(r.max_price_cents, Math.round(ref * 1.01));
    if (price < ref * 0.95) continue;
    const stocked = await db.query<{ company_id: string }>(
      `SELECT DISTINCT company_id FROM inventory WHERE company_id = ANY($1::uuid[]) AND product_id = $2 AND quality >= $3 AND qty >= $4
         AND company_id NOT IN (SELECT seller_id FROM rfq_bids WHERE rfq_id = $5)`,
      [npcIds, r.product_id, r.min_quality, r.qty, r.id],
    );
    for (const s of stocked.rows.slice(0, 1)) await attempt(() => withTx(db, (tx) => placeBid(tx, s.company_id, r.id, price, now)));
  }

  // 3. Award NPC RFQs whose bidding has closed: cheapest bid whose seller can post the bond.
  const closed = await db.query<{ id: string; buyer_id: string }>(
    "SELECT id, buyer_id FROM rfqs WHERE status = 'open' AND closes_at <= $2 AND buyer_id = ANY($1::uuid[])",
    [npcIds, now],
  );
  for (const r of closed.rows) {
    const bids = await db.query<{ id: string }>('SELECT id FROM rfq_bids WHERE rfq_id = $1 ORDER BY price_cents, updated_at', [r.id]);
    for (const b of bids.rows) {
      let ok = false;
      await attempt(async () => {
        await withTx(db, (tx) => awardRfq(tx, r.buyer_id, r.id, b.id, now));
        ok = true;
      });
      if (ok) break;
    }
    if (bids.rowCount === 0) await db.query("UPDATE rfqs SET status = 'expired' WHERE id = $1", [r.id]);
  }

  // 4. Keep a few NPC requests on the board.
  const openCount = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM rfqs WHERE status = 'open' AND buyer_id = ANY($1::uuid[])", [npcIds]);
  let missing = OPEN_NPC_RFQS - openCount.rows[0].n;
  if (missing > 0) {
    const live = await db.query<{ buyer_id: string; product_id: string }>("SELECT buyer_id, product_id FROM rfqs WHERE status = 'open'");
    for (const t of TEMPLATES) {
      if (missing <= 0) break;
      const buyer = npcs.rows.find((n) => n.name === t.buyer);
      if (!buyer || live.rows.some((l) => l.buyer_id === buyer.id && l.product_id === t.productId)) continue;
      const ref = await refPrice(db, t.productId);
      await attempt(() =>
        withTx(db, (tx) =>
          postRfq(tx, buyer.id, {
            productId: t.productId, qty: t.qty, minQuality: t.minQuality, maxPriceCents: Math.round(ref * t.markup),
            frequencyHours: t.frequencyHours, windowHours: t.windowHours, termDays: Math.min(t.termDays, CONTRACT_RULES.maxTermDays),
            minReliability: t.minReliability,
          }, now),
        ),
      );
      missing -= 1;
    }
  }
}
