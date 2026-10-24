import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bondCents, type ContractTerms } from '../../shared/contracts';
import { runBots } from '../src/bots';
import { createCompany } from '../src/companies';
import { acceptContract, offerContract, processContract, rejectContract, reliability, terminateContract } from '../src/contracts';
import { type Db, withTx } from '../src/db';
import { awardRfq, placeBid, postRfq } from '../src/rfq';
import { cash, freshDb, give, goods, ledgerTotal, newCompany } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

const H = 3_600_000; // TIME_SCALE=1 in tests: one game hour is one real hour
const at = (base: Date, hours: number) => new Date(base.getTime() + hours * H);

// 100 flour Q1+ daily for 3 days at 8.00 → 800 CR per delivery.
const terms = (over: Partial<ContractTerms> = {}): ContractTerms => ({
  productId: 'flour', qty: 100, minQuality: 1, priceCents: 800, frequencyHours: 24, windowHours: 8, termDays: 3, ...over,
});

const contract = async (id: string) => (await db.query('SELECT * FROM contracts WHERE id = $1', [id])).rows[0];
const deliveries = async (id: string) => (await db.query('SELECT * FROM contract_deliveries WHERE contract_id = $1 ORDER BY seq', [id])).rows;
const balance = async (companyId: string, kind: string) =>
  (await db.query<{ b: number }>('SELECT balance_cents AS b FROM accounts WHERE company_id = $1 AND kind = $2', [companyId, kind])).rows[0].b;
const process = (id: string, now: Date) => withTx(db, (tx) => processContract(tx, id, now));

/** Buyer offers, seller accepts at `t0`. Returns the contract id. */
async function signed(buyer: string, seller: string, t0: Date, over: Partial<ContractTerms> = {}) {
  const { contractId } = await withTx(db, (tx) => offerContract(tx, buyer, { counterpartyId: seller, role: 'buy', terms: terms(over) }, t0));
  await withTx(db, (tx) => acceptContract(tx, seller, contractId, t0));
  return contractId;
}

let t0: Date;
beforeEach(() => { t0 = new Date(); });

describe('offers and bonds', () => {
  it('posts the seller bond on acceptance and schedules every delivery', async () => {
    const buyer = await newCompany(db);
    const seller = await newCompany(db, { capital: 1_000_00 });
    const id = await signed(buyer.id, seller.id, t0);
    const c = await contract(id);
    expect(c.status).toBe('active');
    expect(c.bond_cents).toBe(bondCents(terms())); // 10% × 3 deliveries × 800 CR = 240 CR
    expect(c.bond_cents).toBe(240_00);
    expect(await balance(seller.id, 'bond')).toBe(240_00);
    expect(await cash(db, seller.id)).toBe(1_000_00 - 240_00);
    const ds = await deliveries(id);
    expect(ds).toHaveLength(3);
    expect(ds[0].window_start.getTime()).toBe(at(t0, 1).getTime());
    expect(ds[1].window_start.getTime() - ds[0].window_start.getTime()).toBe(24 * H);
    expect(ds[0].window_end.getTime() - ds[0].window_start.getTime()).toBe(8 * H);
  });

  it('only the other party can accept; offers can be rejected, withdrawn or expire', async () => {
    const a = await newCompany(db);
    const b = await newCompany(db);
    const { contractId } = await withTx(db, (tx) => offerContract(tx, a.id, { counterpartyId: b.id, role: 'sell', terms: terms() }, t0));
    await expect(withTx(db, (tx) => acceptContract(tx, a.id, contractId, t0))).rejects.toMatchObject({ code: 'own_offer' });
    await expect(withTx(db, (tx) => acceptContract(tx, b.id, contractId, at(t0, 49)))).rejects.toMatchObject({ code: 'expired' });
    expect((await withTx(db, (tx) => rejectContract(tx, b.id, contractId))).status).toBe('rejected');

    const second = await withTx(db, (tx) => offerContract(tx, a.id, { counterpartyId: b.id, role: 'sell', terms: terms() }, t0));
    expect((await withTx(db, (tx) => rejectContract(tx, a.id, second.contractId))).status).toBe('withdrawn');
  });

  it('refuses activation when the seller cannot afford the bond', async () => {
    const buyer = await newCompany(db);
    const seller = await newCompany(db, { capital: 100_00 });
    const { contractId } = await withTx(db, (tx) => offerContract(tx, buyer.id, { counterpartyId: seller.id, role: 'buy', terms: terms() }, t0));
    await expect(withTx(db, (tx) => acceptContract(tx, seller.id, contractId, t0))).rejects.toMatchObject({ code: 'bond_unaffordable' });
    expect((await contract(contractId)).status).toBe('offered');
  });

  it('validates schedule and price band', async () => {
    const a = await newCompany(db);
    const b = await newCompany(db);
    const bad = (over: Partial<ContractTerms>) => withTx(db, (tx) => offerContract(tx, a.id, { counterpartyId: b.id, role: 'buy', terms: terms(over) }, t0));
    await expect(bad({ frequencyHours: 12 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(bad({ frequencyHours: 4, windowHours: 8 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(bad({ termDays: 31 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(bad({ priceCents: 399 })).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('deliveries', () => {
  it('funds escrow when the window opens and settles on time minus the 1% fee', async () => {
    const buyer = await newCompany(db, { capital: 10_000_00 });
    const seller = await newCompany(db, { capital: 1_000_00 });
    await give(db, seller.id, 'flour', 2, 100);
    await give(db, seller.id, 'flour', 1, 100);
    const id = await signed(buyer.id, seller.id, t0);
    const sellerCash = await cash(db, seller.id);

    await process(id, at(t0, 0.5)); // window not open yet
    expect((await deliveries(id))[0].status).toBe('pending');

    await process(id, at(t0, 2));
    const d = (await deliveries(id))[0];
    expect(d).toMatchObject({ status: 'settled', late_hours: 0, delivered_quality: 1, fee_cents: 8_00 });
    // The lowest quality that meets the minimum is delivered.
    expect(await goods(db, buyer.id, 'flour', 1)).toBe(100);
    expect(await goods(db, seller.id, 'flour', 2)).toBe(100);
    expect(await cash(db, buyer.id)).toBe(10_000_00 - 800_00);
    expect(await cash(db, seller.id)).toBe(sellerCash + 800_00 - 8_00);
    expect(await balance(buyer.id, 'escrow')).toBe(0);
    expect((await ledgerTotal(db)).balances).toBe(0);
  });

  it('charges 1% per hour late from the bond, capped at 10%', async () => {
    const buyer = await newCompany(db);
    const seller = await newCompany(db);
    const id = await signed(buyer.id, seller.id, t0);
    await process(id, at(t0, 2)); // funded, no goods
    expect((await deliveries(id))[0].status).toBe('funded');
    await give(db, seller.id, 'flour', 1, 100);
    const buyerCash = await cash(db, buyer.id);
    await process(id, at(t0, 1 + 8 + 2.5)); // window ended at +9h → 3 hours late (rounded up)
    const d = (await deliveries(id))[0];
    expect(d).toMatchObject({ status: 'settled', late_hours: 3, penalty_cents: 24_00 });
    expect(await cash(db, buyer.id)).toBe(buyerCash + 24_00);
    expect((await contract(id)).bond_remaining_cents).toBe(240_00 - 24_00);
  });

  it('treats a delivery missing 24h after its window as a seller breach and ends the contract', async () => {
    const buyer = await newCompany(db, { capital: 10_000_00 });
    const seller = await newCompany(db, { capital: 1_000_00 });
    const id = await signed(buyer.id, seller.id, t0);
    await process(id, at(t0, 2));
    expect(await balance(buyer.id, 'escrow')).toBe(800_00);
    await process(id, at(t0, 1 + 8 + 25));
    const [d1, d2] = await deliveries(id);
    expect(d1).toMatchObject({ status: 'breached', penalty_cents: 80_00 });
    expect(d2.status).toBe('cancelled');
    const c = await contract(id);
    expect(c).toMatchObject({ status: 'terminated_for_breach', end_reason: 'seller_breach', bond_remaining_cents: 0 });
    expect(await cash(db, buyer.id)).toBe(10_000_00 + 80_00); // escrow back plus 10%
    expect(await cash(db, seller.id)).toBe(1_000_00 - 80_00); // bond back minus penalty
    expect((await reliability(db, seller.id)).score).toBeLessThan(80);
    expect((await ledgerTotal(db)).balances).toBe(0);
  });

  it('charges the buyer 5% when it cannot fund a delivery', async () => {
    const buyer = await newCompany(db, { capital: 500_00 });
    const seller = await newCompany(db);
    const id = await signed(buyer.id, seller.id, t0);
    const sellerCash = await cash(db, seller.id);
    await process(id, at(t0, 2));
    expect((await deliveries(id))[0]).toMatchObject({ status: 'unfunded', penalty_cents: 40_00 });
    expect(await cash(db, seller.id)).toBe(sellerCash + 40_00 + 240_00); // penalty plus bond back
    expect((await contract(id)).end_reason).toBe('buyer_unfunded');
  });

  it('completes and returns the bond after the last delivery', async () => {
    const buyer = await newCompany(db);
    const seller = await newCompany(db, { capital: 1_000_00 });
    await give(db, seller.id, 'flour', 1, 300);
    const id = await signed(buyer.id, seller.id, t0);
    for (const h of [2, 26, 50]) await process(id, at(t0, h));
    expect((await contract(id)).status).toBe('completed');
    expect(await balance(seller.id, 'bond')).toBe(0);
    expect(await cash(db, seller.id)).toBe(1_000_00 + 3 * (800_00 - 8_00));
    const rel = await reliability(db, seller.id);
    expect(rel.score).toBeGreaterThan(80);
    expect(rel.verified).toBe(false); // only one buyer so far
  });

  it('ends with 72h notice: later deliveries are cancelled without penalty', async () => {
    const buyer = await newCompany(db);
    const seller = await newCompany(db);
    await give(db, seller.id, 'flour', 1, 1000);
    const id = await signed(buyer.id, seller.id, t0, { termDays: 10 });
    await process(id, at(t0, 2));
    await withTx(db, (tx) => terminateContract(tx, buyer.id, id, at(t0, 3)));
    const ds = await deliveries(id);
    // Windows start at +1, +25, +49, +73 …; notice ends at +75 → deliveries 1–4 remain.
    expect(ds.filter((d) => d.status !== 'cancelled')).toHaveLength(4);
    for (const h of [26, 50, 74]) await process(id, at(t0, h));
    expect((await contract(id)).status).toBe('terminated_by_notice');
  });

  it('suspends contract activity after three breaches in 30 days', async () => {
    const seller = await newCompany(db);
    for (let i = 0; i < 3; i++) {
      const buyer = await newCompany(db);
      const id = await signed(buyer.id, seller.id, t0, { termDays: 1 });
      await process(id, at(t0, 2));
      await process(id, at(t0, 40));
    }
    const other = await newCompany(db);
    await expect(withTx(db, (tx) => offerContract(tx, seller.id, { counterpartyId: other.id, role: 'sell', terms: terms() }, at(t0, 41)))).rejects.toMatchObject({ code: 'suspended' });
  });
});

describe('reliability', () => {
  it('starts at the 80 prior and verifies after three distinct buyers', async () => {
    const seller = await newCompany(db, { capital: 10_000_00 });
    expect(await reliability(db, seller.id)).toMatchObject({ score: 80, verified: false });
    await give(db, seller.id, 'flour', 1, 300);
    for (let i = 0; i < 3; i++) {
      const buyer = await newCompany(db);
      const id = await signed(buyer.id, seller.id, t0, { termDays: 1 });
      await process(id, at(t0, 2));
    }
    const rel = await reliability(db, seller.id);
    expect(rel.verified).toBe(true);
    // (2,400 + 40,000) / (2,400 + 50,000) = 80.9
    expect(rel.score).toBe(80.9);
  });
});

describe('RFQ board', () => {
  it('keeps bids sealed until close, then awards and starts the contract', async () => {
    const buyer = await newCompany(db);
    const cheap = await newCompany(db);
    const dear = await newCompany(db);
    const { rfqId } = await withTx(db, (tx) =>
      postRfq(tx, buyer.id, { productId: 'flour', qty: 100, minQuality: 1, maxPriceCents: 900, frequencyHours: 24, windowHours: 24, termDays: 2, minReliability: 0 }, t0),
    );
    await expect(withTx(db, (tx) => placeBid(tx, cheap.id, rfqId, 901, t0))).rejects.toMatchObject({ code: 'bad_request' });
    const low = await withTx(db, (tx) => placeBid(tx, cheap.id, rfqId, 820, t0));
    await withTx(db, (tx) => placeBid(tx, dear.id, rfqId, 860, t0));
    await withTx(db, (tx) => placeBid(tx, cheap.id, rfqId, 810, at(t0, 1))); // update own bid
    await expect(withTx(db, (tx) => awardRfq(tx, buyer.id, rfqId, low.bidId, at(t0, 2)))).rejects.toMatchObject({ code: 'sealed' });
    await expect(withTx(db, (tx) => placeBid(tx, dear.id, rfqId, 850, at(t0, 25)))).rejects.toMatchObject({ code: 'closed' });

    const { contractId } = await withTx(db, (tx) => awardRfq(tx, buyer.id, rfqId, low.bidId, at(t0, 25)));
    const c = await contract(contractId);
    expect(c).toMatchObject({ status: 'active', seller_id: cheap.id, price_cents: 810, rfq_id: rfqId });
    expect((await db.query('SELECT status FROM rfqs WHERE id = $1', [rfqId])).rows[0].status).toBe('awarded');
  });

  it('enforces the minimum reliability on bidders', async () => {
    const buyer = await newCompany(db);
    const seller = await newCompany(db);
    const { rfqId } = await withTx(db, (tx) =>
      postRfq(tx, buyer.id, { productId: 'wheat', qty: 100, minQuality: 0, maxPriceCents: 500, frequencyHours: 24, windowHours: 24, termDays: 2, minReliability: 85 }, t0),
    );
    await expect(withTx(db, (tx) => placeBid(tx, seller.id, rfqId, 450, t0))).rejects.toMatchObject({ code: 'reliability' });
  });
});

describe('NPC counterparties', () => {
  it('answer offers, bid on player RFQs, post their own and award them', async () => {
    const { company: npc } = await createCompany(db, { name: `NPC Mill ${Date.now() % 10000}`, isNpc: true, capitalCents: 1_000_000_00, level: 30 });
    await give(db, npc.id, 'flour', 1, 5000);
    const player = await newCompany(db);

    const fair = await withTx(db, (tx) => offerContract(tx, player.id, { counterpartyId: npc.id, role: 'buy', terms: terms({ priceCents: 800 }) }, t0));
    const lowball = await withTx(db, (tx) => offerContract(tx, player.id, { counterpartyId: npc.id, role: 'buy', terms: terms({ priceCents: 600 }) }, t0));
    const { rfqId } = await withTx(db, (tx) =>
      postRfq(tx, player.id, { productId: 'flour', qty: 100, minQuality: 1, maxPriceCents: 900, frequencyHours: 24, windowHours: 24, termDays: 2, minReliability: 0 }, t0),
    );

    await runBots(db, at(t0, 0.5)); // too soon: NPCs take a game hour to respond
    expect((await contract(fair.contractId)).status).toBe('offered');

    await runBots(db, at(t0, 1.5));
    expect((await contract(fair.contractId)).status).toBe('active');
    expect((await contract(lowball.contractId)).status).toBe('rejected');
    const bid = (await db.query('SELECT * FROM rfq_bids WHERE rfq_id = $1', [rfqId])).rows[0];
    expect(bid).toMatchObject({ seller_id: npc.id, price_cents: 808 });

    // NPC RFQs: one is posted, the player bids, and it is awarded after close.
    const npcRfq = (await db.query("SELECT * FROM rfqs WHERE buyer_id = $1 AND status = 'open'", [npc.id])).rows;
    // The test NPC has no template of its own, so post one for it directly.
    const { rfqId: npcRfqId } = await withTx(db, (tx) =>
      postRfq(tx, npc.id, { productId: 'wheat', qty: 50, minQuality: 0, maxPriceCents: 480, frequencyHours: 24, windowHours: 24, termDays: 1, minReliability: 0 }, t0),
    );
    expect(npcRfq.length).toBe(0);
    await withTx(db, (tx) => placeBid(tx, player.id, npcRfqId, 460, at(t0, 1)));
    await runBots(db, at(t0, 25));
    const awarded = (await db.query('SELECT * FROM rfqs WHERE id = $1', [npcRfqId])).rows[0];
    expect(awarded.status).toBe('awarded');
    expect((await contract(awarded.contract_id)).seller_id).toBe(player.id);
  });
});
