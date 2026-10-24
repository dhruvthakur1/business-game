import { runBots } from './bots';
import { isFinal, processContract, reliability, type ContractRow, type DeliveryRow } from './contracts';
import { type Db, withTx } from './db';
import { expireRfqs } from './rfq';

/**
 * One scheduler pass: expire stale offers and RFQs, let NPCs act, then advance every active contract
 * that has a delivery window open. Safe to run concurrently: each contract is processed under a row lock.
 */
export async function processContracts(db: Db, now = new Date()) {
  await db.query("UPDATE contracts SET status = 'expired', ended_at = $1 WHERE status = 'offered' AND offer_expires_at < $1", [now]);
  await expireRfqs(db, now);
  await runBots(db, now);
  const due = await db.query<{ contract_id: string }>(
    `SELECT DISTINCT d.contract_id FROM contract_deliveries d JOIN contracts c ON c.id = d.contract_id
     WHERE c.status = 'active' AND d.status IN ('pending', 'funded') AND d.window_start <= $1`,
    [now],
  );
  for (const row of due.rows) await withTx(db, (tx) => processContract(tx, row.contract_id, now));
  return due.rowCount ?? 0;
}

const deliveryView = (d: DeliveryRow) => ({
  id: d.id,
  seq: d.seq,
  windowStart: d.window_start.toISOString(),
  windowEnd: d.window_end.toISOString(),
  valueCents: Number(d.value_cents),
  status: d.status,
  deliveredAt: d.delivered_at?.toISOString() ?? null,
  deliveredQuality: d.delivered_quality,
  lateHours: d.late_hours,
  penaltyCents: Number(d.penalty_cents),
  feeCents: Number(d.fee_cents),
});

/** The company's contracts (both sides), newest first, with delivery progress. */
export async function contractsView(db: Db, companyId: string) {
  const res = await db.query<ContractRow & { buyer_name: string; seller_name: string }>(
    `SELECT c.*, b.name AS buyer_name, s.name AS seller_name FROM contracts c
     JOIN companies b ON b.id = c.buyer_id JOIN companies s ON s.id = c.seller_id
     WHERE (c.buyer_id = $1 OR c.seller_id = $1)
       AND (c.status IN ('offered', 'active') OR c.ended_at > now() - interval '7 days')
     ORDER BY CASE c.status WHEN 'offered' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, c.created_at DESC LIMIT 60`,
    [companyId],
  );
  const ids = res.rows.map((c) => c.id);
  const deliveries = ids.length
    ? (await db.query<DeliveryRow>('SELECT * FROM contract_deliveries WHERE contract_id = ANY($1::uuid[]) ORDER BY seq', [ids])).rows
    : [];
  const company = await db.query<{ contracts_suspended_until: Date | null }>('SELECT contracts_suspended_until FROM companies WHERE id = $1', [companyId]);
  return {
    reliability: await reliability(db, companyId),
    suspendedUntil: company.rows[0].contracts_suspended_until?.toISOString() ?? null,
    contracts: res.rows.map((c) => {
      const ds = deliveries.filter((d) => d.contract_id === c.id);
      const role = c.buyer_id === companyId ? 'buyer' : 'seller';
      return {
        id: c.id,
        role,
        counterpartyId: role === 'buyer' ? c.seller_id : c.buyer_id,
        counterpartyName: role === 'buyer' ? c.seller_name : c.buyer_name,
        proposedByMe: c.proposer_id === companyId,
        productId: c.product_id,
        qty: c.qty,
        minQuality: c.min_quality,
        priceCents: Number(c.price_cents),
        frequencyHours: c.frequency_hours,
        windowHours: c.window_hours,
        termDays: c.term_days,
        status: c.status,
        bondCents: Number(c.bond_cents),
        bondRemainingCents: Number(c.bond_remaining_cents),
        offerExpiresAt: c.offer_expires_at?.toISOString() ?? null,
        acceptedAt: c.accepted_at?.toISOString() ?? null,
        noticeEndsAt: c.notice_ends_at?.toISOString() ?? null,
        endedAt: c.ended_at?.toISOString() ?? null,
        endReason: c.end_reason,
        fromRfq: !!c.rfq_id,
        deliveries: ds.map(deliveryView),
        summary: {
          total: ds.length,
          settled: ds.filter((d) => d.status === 'settled').length,
          onTime: ds.filter((d) => d.status === 'settled' && d.late_hours === 0).length,
          open: ds.filter((d) => !isFinal(d.status)).length,
        },
      };
    }),
  };
}

/** Companies offering a product: open asks on the exchange or past contract deliveries. */
export async function suppliers(db: Db, companyId: string, productId: string) {
  const res = await db.query<{ id: string; name: string; region: string; is_npc: boolean; min_ask: number | null; qmin: number | null; qmax: number | null; delivered: number }>(
    `SELECT c.id, c.name, c.region, c.is_npc,
            (SELECT MIN(price_cents) FROM orders o WHERE o.company_id = c.id AND o.product_id = $2 AND o.side = 'sell' AND o.status = 'open') AS min_ask,
            (SELECT MIN(quality) FROM orders o WHERE o.company_id = c.id AND o.product_id = $2 AND o.side = 'sell' AND o.status = 'open') AS qmin,
            (SELECT MAX(quality) FROM orders o WHERE o.company_id = c.id AND o.product_id = $2 AND o.side = 'sell' AND o.status = 'open') AS qmax,
            (SELECT COUNT(*)::int FROM contract_deliveries d JOIN contracts k ON k.id = d.contract_id
               WHERE k.seller_id = c.id AND k.product_id = $2 AND d.status = 'settled') AS delivered
     FROM companies c WHERE c.id <> $1`,
    [companyId, productId],
  );
  const rows = res.rows.filter((r) => r.min_ask !== null || r.delivered > 0);
  return Promise.all(
    rows.map(async (r) => {
      const rel = await reliability(db, r.id);
      return {
        companyId: r.id,
        name: r.name,
        region: r.region,
        isNpc: r.is_npc,
        askCents: r.min_ask === null ? null : Number(r.min_ask),
        qualityRange: r.qmin === null ? null : r.qmin === r.qmax ? `Q${r.qmin}` : `Q${r.qmin}–Q${r.qmax}`,
        delivered: r.delivered,
        reliability: rel.score,
        verified: rel.verified,
      };
    }),
  ).then((list) => list.sort((a, b) => b.reliability - a.reliability || (a.askCents ?? Infinity) - (b.askCents ?? Infinity)));
}
