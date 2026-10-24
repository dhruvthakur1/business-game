import { PRICE_BAND } from '../../shared/catalog';
import {
  bondCents,
  CONTRACT_RULES,
  deliveryCount,
  deliveryValueCents,
  RELIABILITY,
  type ContractStatus,
  type ContractTerms,
  type DeliveryStatus,
} from '../../shared/contracts';
import type { Tx } from './db';
import { badRequest, conflict, notFound } from './errors';
import { addGoods, takeGoods } from './inventory';
import { companyAccount, systemAccount, toCents, transfer } from './ledger';
import { loadProduct } from './catalog';
import { gameDayMs, gameHoursMs } from './time';
import { awardXp } from './xp';
import { XP_CAPS, XP_PER_CR_CONTRACT_BUYER, XP_PER_CR_CONTRACT_SELLER } from '../../shared/levels';

type Q = Pick<Tx, 'query'>;

export interface ContractRow {
  id: string;
  buyer_id: string;
  seller_id: string;
  proposer_id: string;
  product_id: string;
  qty: number;
  min_quality: number;
  price_cents: number;
  frequency_hours: number;
  window_hours: number;
  term_days: number;
  status: ContractStatus;
  bond_cents: number;
  bond_remaining_cents: number;
  offer_expires_at: Date | null;
  accepted_at: Date | null;
  notice_ends_at: Date | null;
  ended_at: Date | null;
  end_reason: string | null;
  rfq_id: string | null;
  created_at: Date;
}

export interface DeliveryRow {
  id: string;
  contract_id: string;
  seq: number;
  window_start: Date;
  window_end: Date;
  value_cents: number;
  status: DeliveryStatus;
  funded_cents: number;
  delivered_at: Date | null;
  delivered_quality: number | null;
  late_hours: number;
  penalty_cents: number;
  fee_cents: number;
}

const FINAL: DeliveryStatus[] = ['unfunded', 'settled', 'breached', 'cancelled'];

export const termsOf = (c: ContractRow): ContractTerms => ({
  productId: c.product_id,
  qty: c.qty,
  minQuality: c.min_quality,
  priceCents: c.price_cents,
  frequencyHours: c.frequency_hours,
  windowHours: c.window_hours,
  termDays: c.term_days,
});

/** Checks schedule shape, quantity, quality and that the price sits within 0.5×–2× reference. */
export async function validateTerms(q: Q, t: ContractTerms) {
  if (!CONTRACT_RULES.frequencies.includes(t.frequencyHours)) throw badRequest('Frequency must be every 4h, daily or weekly.');
  if (!CONTRACT_RULES.windows.includes(t.windowHours) || t.windowHours > t.frequencyHours) {
    throw badRequest('Delivery window must be 4, 8 or 24 hours and no longer than the frequency.');
  }
  if (!Number.isInteger(t.termDays) || t.termDays < 1 || t.termDays > CONTRACT_RULES.maxTermDays) throw badRequest('Term must be 1–30 days.');
  if (!Number.isInteger(t.qty) || t.qty < 1 || t.qty > 100_000) throw badRequest('Quantity per delivery must be 1–100,000.');
  if (!Number.isInteger(t.minQuality) || t.minQuality < 0 || t.minQuality > 5) throw badRequest('Minimum quality must be 0–5.');
  const p = await loadProduct(q, t.productId);
  const min = Math.ceil(p.refPriceCents * PRICE_BAND.min);
  const max = Math.floor(p.refPriceCents * PRICE_BAND.max);
  if (!Number.isInteger(t.priceCents) || t.priceCents < min || t.priceCents > max) {
    throw badRequest(`Unit price must be between ${(min / 100).toFixed(2)} and ${(max / 100).toFixed(2)} CR (0.5×–2× reference).`);
  }
  return p;
}

/** Throws unless the company may create or accept contracts right now. */
export async function assertCanContract(q: Q, companyId: string, now: Date) {
  const c = (await q.query<{ level: number; contracts_suspended_until: Date | null }>(
    'SELECT level, contracts_suspended_until FROM companies WHERE id = $1',
    [companyId],
  )).rows[0];
  if (!c) throw notFound('Company');
  if (c.level < CONTRACT_RULES.minLevel) throw conflict('locked', `Contracts unlock at company level ${CONTRACT_RULES.minLevel}.`);
  if (c.contracts_suspended_until && c.contracts_suspended_until > now) {
    throw conflict('suspended', `Contract activity is suspended after repeated breaches until ${c.contracts_suspended_until.toISOString()}.`);
  }
}

export async function lockContract(tx: Tx, id: string): Promise<ContractRow> {
  const res = await tx.query<ContractRow>('SELECT * FROM contracts WHERE id = $1 FOR UPDATE', [id]);
  if (!res.rows[0]) throw notFound('Contract');
  return res.rows[0];
}

// ---------------------------------------------------------------- offers

export async function offerContract(
  tx: Tx,
  proposerId: string,
  input: { counterpartyId: string; role: 'buy' | 'sell'; terms: ContractTerms },
  now = new Date(),
) {
  if (input.counterpartyId === proposerId) throw badRequest('You cannot contract with yourself.');
  await assertCanContract(tx, proposerId, now);
  const other = await tx.query('SELECT 1 FROM companies WHERE id = $1', [input.counterpartyId]);
  if (!other.rowCount) throw notFound('Counterparty');
  await validateTerms(tx, input.terms);
  const t = input.terms;
  const [buyer, seller] = input.role === 'buy' ? [proposerId, input.counterpartyId] : [input.counterpartyId, proposerId];
  const res = await tx.query<{ id: string }>(
    `INSERT INTO contracts (buyer_id, seller_id, proposer_id, product_id, qty, min_quality, price_cents, frequency_hours, window_hours,
                            term_days, status, bond_cents, offer_expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'offered', $11, $12, $13) RETURNING id`,
    [buyer, seller, proposerId, t.productId, t.qty, t.minQuality, t.priceCents, t.frequencyHours, t.windowHours, t.termDays,
      bondCents(t), new Date(now.getTime() + gameHoursMs(CONTRACT_RULES.offerHours)), now],
  );
  return { contractId: res.rows[0].id, bondCents: bondCents(t) };
}

/** Posts the seller's bond and schedules every delivery window. Used by accept and by RFQ awards. */
export async function activate(tx: Tx, c: ContractRow, now: Date) {
  const sellerCash = await companyAccount(tx, c.seller_id, 'cash');
  const sellerBond = await companyAccount(tx, c.seller_id, 'bond');
  try {
    await transfer(tx, 'contract_bond', `Performance bond: contract ${c.id.slice(0, 8)}`, sellerCash, sellerBond, c.bond_cents, `bond:${c.id}`);
  } catch (err) {
    if ((err as { code?: string }).code === 'insufficient_funds') {
      throw conflict('bond_unaffordable', `The seller needs ${(c.bond_cents / 100).toFixed(2)} CR in cash for the performance bond.`);
    }
    throw err;
  }
  const t = termsOf(c);
  const first = now.getTime() + gameHoursMs(CONTRACT_RULES.firstWindowDelayHours);
  const value = deliveryValueCents(t);
  for (let i = 0; i < deliveryCount(t); i++) {
    const start = new Date(first + i * gameHoursMs(t.frequencyHours));
    const end = new Date(start.getTime() + gameHoursMs(t.windowHours));
    await tx.query(
      'INSERT INTO contract_deliveries (contract_id, seq, window_start, window_end, value_cents) VALUES ($1, $2, $3, $4, $5)',
      [c.id, i + 1, start, end, value],
    );
  }
  await tx.query(
    "UPDATE contracts SET status = 'active', accepted_at = $2, bond_remaining_cents = bond_cents WHERE id = $1",
    [c.id, now],
  );
}

export async function acceptContract(tx: Tx, companyId: string, contractId: string, now = new Date()) {
  const c = await lockContract(tx, contractId);
  if (c.buyer_id !== companyId && c.seller_id !== companyId) throw notFound('Contract');
  if (c.proposer_id === companyId) throw conflict('own_offer', 'The other party has to accept your offer.');
  if (c.status !== 'offered') throw conflict('not_offered', 'This offer is no longer open.');
  if (c.offer_expires_at && c.offer_expires_at <= now) throw conflict('expired', 'This offer has expired.');
  await assertCanContract(tx, companyId, now);
  await activate(tx, c, now);
  return { contractId, status: 'active' as const };
}

export async function rejectContract(tx: Tx, companyId: string, contractId: string) {
  const c = await lockContract(tx, contractId);
  if (c.buyer_id !== companyId && c.seller_id !== companyId) throw notFound('Contract');
  if (c.status !== 'offered') throw conflict('not_offered', 'This offer is no longer open.');
  const status = c.proposer_id === companyId ? 'withdrawn' : 'rejected';
  await tx.query('UPDATE contracts SET status = $2, ended_at = now() WHERE id = $1', [contractId, status]);
  return { contractId, status };
}

/** Either party may end an active contract with 72 game hours' notice and no penalty. */
export async function terminateContract(tx: Tx, companyId: string, contractId: string, now = new Date()) {
  const c = await lockContract(tx, contractId);
  if (c.buyer_id !== companyId && c.seller_id !== companyId) throw notFound('Contract');
  if (c.status !== 'active') throw conflict('not_active', 'Only active contracts can be ended.');
  if (c.notice_ends_at) throw conflict('notice_given', 'Notice has already been given.');
  const ends = new Date(now.getTime() + gameHoursMs(CONTRACT_RULES.noticeHours));
  await tx.query('UPDATE contracts SET notice_ends_at = $2 WHERE id = $1', [contractId, ends]);
  await tx.query("UPDATE contract_deliveries SET status = 'cancelled', resolved_at = $3 WHERE contract_id = $1 AND status = 'pending' AND window_start > $2", [contractId, ends, now]);
  await processContract(tx, contractId, now);
  return { contractId, noticeEndsAt: ends.toISOString() };
}

// ---------------------------------------------------------------- deliveries

const cashBalance = async (tx: Tx, companyId: string) =>
  (await tx.query<{ balance_cents: number }>("SELECT balance_cents FROM accounts WHERE company_id = $1 AND kind = 'cash'", [companyId])).rows[0].balance_cents;

/** Pays a penalty to `to`: first from the contract's bond, then from the payer's cash, never more than exists. */
async function payPenalty(tx: Tx, c: ContractRow, payerId: string, toId: string, amount: number, memo: string): Promise<number> {
  let paid = 0;
  const to = await companyAccount(tx, toId, 'cash');
  if (payerId === c.seller_id && c.bond_remaining_cents > 0) {
    const fromBond = Math.min(amount, c.bond_remaining_cents);
    await transfer(tx, 'contract_penalty', memo, await companyAccount(tx, payerId, 'bond'), to, fromBond);
    c.bond_remaining_cents -= fromBond;
    await tx.query('UPDATE contracts SET bond_remaining_cents = $2 WHERE id = $1', [c.id, c.bond_remaining_cents]);
    paid += fromBond;
  }
  const rest = Math.min(amount - paid, await cashBalance(tx, payerId));
  if (rest > 0) {
    await transfer(tx, 'contract_penalty', memo, await companyAccount(tx, payerId, 'cash'), to, rest);
    paid += rest;
  }
  return paid;
}

/** NPC sellers are backed by the wider world: if they run short, goods are restocked. */
async function npcRestock(tx: Tx, c: ContractRow) {
  const npc = await tx.query<{ is_npc: boolean }>('SELECT is_npc FROM companies WHERE id = $1', [c.seller_id]);
  if (npc.rows[0]?.is_npc) await addGoods(tx, c.seller_id, c.product_id, Math.max(c.min_quality, 1), c.qty);
}

async function pickLot(tx: Tx, c: ContractRow): Promise<number | null> {
  const res = await tx.query<{ quality: number }>(
    `SELECT quality FROM inventory WHERE company_id = $1 AND product_id = $2 AND quality >= $3 AND qty >= $4
     ORDER BY quality ASC LIMIT 1`,
    [c.seller_id, c.product_id, c.min_quality, c.qty],
  );
  return res.rows[0]?.quality ?? null;
}

async function recordBreach(tx: Tx, companyId: string, now: Date) {
  const since = new Date(now.getTime() - CONTRACT_RULES.breachLookbackDays * gameDayMs());
  const n = await tx.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM contract_deliveries d JOIN contracts c ON c.id = d.contract_id
     WHERE d.resolved_at >= $2 AND ((d.status = 'breached' AND c.seller_id = $1) OR (d.status = 'unfunded' AND c.buyer_id = $1))`,
    [companyId, since],
  );
  if (n.rows[0].n >= CONTRACT_RULES.breachLimit) {
    await tx.query('UPDATE companies SET contracts_suspended_until = $2 WHERE id = $1', [companyId, new Date(now.getTime() + CONTRACT_RULES.suspensionDays * gameDayMs())]);
  }
}

/** Ends the contract after a breach: remaining deliveries are cancelled, held escrow refunded, the rest of the bond released. */
async function terminateForBreach(tx: Tx, c: ContractRow, now: Date, reason: string) {
  const funded = await tx.query<DeliveryRow>("SELECT * FROM contract_deliveries WHERE contract_id = $1 AND status = 'funded'", [c.id]);
  for (const d of funded.rows) {
    await transfer(tx, 'contract_refund', 'Contract ended: escrow returned', await companyAccount(tx, c.buyer_id, 'escrow'), await companyAccount(tx, c.buyer_id, 'cash'), d.funded_cents);
  }
  await tx.query(
    "UPDATE contract_deliveries SET status = 'cancelled', resolved_at = $2 WHERE contract_id = $1 AND status IN ('pending', 'funded')",
    [c.id, now],
  );
  c.status = 'terminated_for_breach';
  c.end_reason = reason;
  await finalize(tx, c, now);
}

async function finalize(tx: Tx, c: ContractRow, now: Date) {
  if (c.bond_remaining_cents > 0) {
    await transfer(tx, 'contract_bond_release', 'Performance bond returned', await companyAccount(tx, c.seller_id, 'bond'), await companyAccount(tx, c.seller_id, 'cash'), c.bond_remaining_cents, `bond-release:${c.id}`);
  }
  await tx.query('UPDATE contracts SET status = $2, bond_remaining_cents = 0, ended_at = $3, end_reason = $4 WHERE id = $1', [c.id, c.status, now, c.end_reason]);
}

/**
 * Advances one active contract to `now`:
 * - a pending delivery whose window has opened is funded from the buyer's cash into escrow
 *   (if the buyer cannot pay, that is a buyer breach: 5% penalty to the seller, contract ends);
 * - a funded delivery is made as soon as the seller has enough goods of the minimum quality;
 *   settlement releases escrow to the seller minus the 1% fee, and late deliveries pay 1%/hour (max 10%)
 *   from the bond to the buyer;
 * - a delivery still missing 24 game hours after its window closes is a seller breach: escrow returns to
 *   the buyer plus 10% from the bond, contract ends.
 * Idempotent: every step moves a delivery to a new status inside the same transaction.
 */
export async function processContract(tx: Tx, contractId: string, now = new Date()) {
  const c = await lockContract(tx, contractId);
  if (c.status !== 'active') return;
  const deliveries = await tx.query<DeliveryRow>(
    "SELECT * FROM contract_deliveries WHERE contract_id = $1 AND status IN ('pending', 'funded') AND window_start <= $2 ORDER BY seq FOR UPDATE",
    [c.id, now],
  );
  const product = await loadProduct(tx, c.product_id);
  const feeSink = await systemAccount(tx, 'sink:contract_fees');

  for (const d of deliveries.rows) {
    if (d.status === 'pending') {
      const buyerCash = await companyAccount(tx, c.buyer_id, 'cash');
      if ((await cashBalance(tx, c.buyer_id)) < d.value_cents) {
        const penalty = Math.round(d.value_cents * CONTRACT_RULES.buyerUnfundedPct);
        const paid = await payPenalty(tx, c, c.buyer_id, c.seller_id, penalty, `Buyer could not fund delivery #${d.seq}`);
        await tx.query("UPDATE contract_deliveries SET status = 'unfunded', penalty_cents = $2, resolved_at = $3 WHERE id = $1", [d.id, paid, now]);
        await recordBreach(tx, c.buyer_id, now);
        await terminateForBreach(tx, c, now, 'buyer_unfunded');
        return;
      }
      await transfer(tx, 'contract_funding', `Escrow for ${c.qty} ${product.name} (delivery #${d.seq})`, buyerCash, await companyAccount(tx, c.buyer_id, 'escrow'), d.value_cents, `fund:${d.id}`);
      await tx.query("UPDATE contract_deliveries SET status = 'funded', funded_cents = $2 WHERE id = $1", [d.id, d.value_cents]);
      d.status = 'funded';
      d.funded_cents = d.value_cents;
    }

    // Funded: deliver if the goods are there.
    let lot = await pickLot(tx, c);
    if (lot === null && now.getTime() <= d.window_end.getTime() + gameHoursMs(CONTRACT_RULES.breachAfterHours)) {
      await npcRestock(tx, c);
      lot = await pickLot(tx, c);
    }
    if (lot !== null) {
      await takeGoods(tx, c.seller_id, c.product_id, lot, c.qty);
      await addGoods(tx, c.buyer_id, c.product_id, lot, c.qty);
      const fee = Math.round(d.funded_cents * CONTRACT_RULES.feePct);
      const buyerEscrow = await companyAccount(tx, c.buyer_id, 'escrow');
      await transfer(tx, 'contract_settlement', `Delivered ${c.qty} ${product.name} Q${lot} (#${d.seq})`, buyerEscrow, await companyAccount(tx, c.seller_id, 'cash'), d.funded_cents - fee, `settle:${d.id}`);
      if (fee > 0) await transfer(tx, 'contract_settlement', `Contract fee (#${d.seq})`, buyerEscrow, feeSink, fee, `fee:${d.id}`);
      const lateHours = now > d.window_end ? Math.ceil((now.getTime() - d.window_end.getTime()) / gameHoursMs(1)) : 0;
      let penalty = 0;
      if (lateHours > 0) {
        const pct = Math.min(CONTRACT_RULES.lateCapPct, CONTRACT_RULES.latePctPerHour * lateHours);
        penalty = await payPenalty(tx, c, c.seller_id, c.buyer_id, Math.round(d.funded_cents * pct), `Late delivery #${d.seq} (${lateHours}h)`);
      }
      await tx.query(
        "UPDATE contract_deliveries SET status = 'settled', delivered_at = $2, delivered_quality = $3, late_hours = $4, penalty_cents = $5, fee_cents = $6, resolved_at = $2 WHERE id = $1",
        [d.id, now, lot, lateHours, penalty, fee],
      );
      const valueCr = d.funded_cents / 100;
      await awardXp(tx, c.seller_id, 'contract_sale', valueCr * XP_PER_CR_CONTRACT_SELLER * (lateHours > 0 ? 0.5 : 1), {
        note: `Contract delivery: ${c.qty} ${product.name}`, capKey: `contract:${c.buyer_id}`, dailyCap: XP_CAPS.contractPerBuyer, now,
      });
      await awardXp(tx, c.buyer_id, 'contract_purchase', valueCr * XP_PER_CR_CONTRACT_BUYER, {
        note: `Contract purchase: ${c.qty} ${product.name}`, capKey: 'market', dailyCap: XP_CAPS.market, now,
      });
      continue;
    }

    if (now.getTime() > d.window_end.getTime() + gameHoursMs(CONTRACT_RULES.breachAfterHours)) {
      await transfer(tx, 'contract_refund', `Delivery #${d.seq} not made: escrow returned`, await companyAccount(tx, c.buyer_id, 'escrow'), await companyAccount(tx, c.buyer_id, 'cash'), d.funded_cents, `refund:${d.id}`);
      const penalty = await payPenalty(tx, c, c.seller_id, c.buyer_id, Math.round(d.funded_cents * CONTRACT_RULES.sellerBreachPct), `Delivery #${d.seq} not made`);
      await tx.query("UPDATE contract_deliveries SET status = 'breached', penalty_cents = $2, resolved_at = $3 WHERE id = $1", [d.id, penalty, now]);
      await recordBreach(tx, c.seller_id, now);
      await terminateForBreach(tx, c, now, 'seller_breach');
      return;
    }
  }

  const open = await tx.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM contract_deliveries WHERE contract_id = $1 AND status IN ('pending', 'funded')", [c.id]);
  if (open.rows[0].n === 0) {
    c.status = c.notice_ends_at ? 'terminated_by_notice' : 'completed';
    c.end_reason = c.notice_ends_at ? 'notice' : 'completed';
    await finalize(tx, c, now);
  }
}

// ---------------------------------------------------------------- reliability

export interface Reliability {
  score: number;
  verified: boolean;
  onTimeCents: number;
  totalCents: number;
  counterparties: number;
}

/**
 * reliability = (on-time value + 80% × 50,000 CR) / (total value + 50,000 CR) × 100, over deliveries
 * the company owed as a seller. Unverified until it has delivered to 3 distinct buyers.
 */
export async function reliability(q: Q, companyId: string): Promise<Reliability> {
  const res = await q.query<{ on_time: number; total: number; buyers: number }>(
    `SELECT COALESCE(SUM(d.value_cents) FILTER (WHERE d.status = 'settled' AND d.late_hours = 0), 0)::bigint AS on_time,
            COALESCE(SUM(d.value_cents) FILTER (WHERE d.status IN ('settled', 'breached')), 0)::bigint AS total,
            COUNT(DISTINCT c.buyer_id) FILTER (WHERE d.status = 'settled')::int AS buyers
     FROM contract_deliveries d JOIN contracts c ON c.id = d.contract_id WHERE c.seller_id = $1`,
    [companyId],
  );
  const prior = toCents(RELIABILITY.priorCr);
  const r = res.rows[0];
  const onTime = Number(r.on_time);
  const total = Number(r.total);
  return {
    score: Math.round(((onTime + RELIABILITY.priorScore * prior) / (total + prior)) * 1000) / 10,
    verified: r.buyers >= RELIABILITY.minCounterparties,
    onTimeCents: onTime,
    totalCents: total,
    counterparties: r.buyers,
  };
}

export const isFinal = (s: DeliveryStatus) => FINAL.includes(s);
