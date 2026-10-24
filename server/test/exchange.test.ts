import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db, withTx } from '../src/db';
import { cancelOrder, orderBook, placeOrder, type PlaceOrderInput } from '../src/exchange';
import { cash, freshDb, give, goods, ledgerTotal, newCompany } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

const order = (companyId: string, o: PlaceOrderInput) => withTx(db, (tx) => placeOrder(tx, companyId, o));
const fees = async () => (await db.query<{ b: number }>("SELECT balance_cents AS b FROM accounts WHERE kind = 'sink:exchange_fees'")).rows[0]?.b ?? 0;
const flourId = 'flour'; // reference 8.00

describe('exchange', () => {
  it('matches a buy against a cheaper resting ask at the maker price, with fee and refund', async () => {
    const seller = await newCompany(db, { capital: 0 });
    const buyer = await newCompany(db, { capital: 10_000_00 });
    await give(db, seller.id, flourId, 1, 100);

    const ask = await order(seller.id, { productId: flourId, side: 'sell', qty: 100, priceCents: 800, quality: 1 });
    expect(ask.status).toBe('open');
    expect(await goods(db, seller.id, flourId, 1)).toBe(0);

    const feesBefore = await fees();
    const bid = await order(buyer.id, { productId: flourId, side: 'buy', qty: 60, priceCents: 850, quality: 1 });
    expect(bid.status).toBe('filled');
    expect(bid.fills).toEqual([expect.objectContaining({ qty: 60, priceCents: 800, quality: 1, feeCents: 960 })]);

    expect(await cash(db, buyer.id)).toBe(10_000_00 - 60 * 800);
    expect(await cash(db, buyer.id, 'escrow')).toBe(0);
    expect(await cash(db, seller.id)).toBe(60 * 800 - 960);
    expect(await fees()).toBe(feesBefore + 960);
    expect(await goods(db, buyer.id, flourId, 1)).toBe(60);

    const book = await orderBook(db, flourId);
    expect(book.asks).toEqual([expect.objectContaining({ priceCents: 800, qty: 40 })]);
    expect((await ledgerTotal(db)).balances).toBe(0);
  });

  it('uses price-time priority and walks the book', async () => {
    const a = await newCompany(db, { capital: 0 });
    const b = await newCompany(db, { capital: 0 });
    const buyer = await newCompany(db);
    await give(db, a.id, 'steel', 0, 100);
    await give(db, b.id, 'steel', 0, 100);
    await order(a.id, { productId: 'steel', side: 'sell', qty: 50, priceCents: 2500, quality: 0 });
    await order(b.id, { productId: 'steel', side: 'sell', qty: 50, priceCents: 2400, quality: 0 });
    await order(a.id, { productId: 'steel', side: 'sell', qty: 50, priceCents: 2400, quality: 0 }); // same price, later

    const res = await order(buyer.id, { productId: 'steel', side: 'buy', qty: 120, priceCents: 2600, quality: 0 });
    expect(res.fills.map((f) => [f.qty, f.priceCents])).toEqual([[50, 2400], [50, 2400], [20, 2500]]);
    // b's 2400 ask was first in time at the best price.
    expect(await cash(db, b.id)).toBe(50 * 2400 - Math.round(50 * 2400 * 0.02));
  });

  it('respects the minimum quality on bids', async () => {
    const seller = await newCompany(db, { capital: 0 });
    const buyer = await newCompany(db);
    await give(db, seller.id, 'wheat', 0, 100);
    await order(seller.id, { productId: 'wheat', side: 'sell', qty: 100, priceCents: 400, quality: 0 });
    const res = await order(buyer.id, { productId: 'wheat', side: 'buy', qty: 100, priceCents: 500, quality: 1 });
    expect(res.fills).toEqual([]);
    expect(res.status).toBe('open');
  });

  it('a sell order fills against resting bids at the bid price', async () => {
    const buyer = await newCompany(db);
    const seller = await newCompany(db, { capital: 0 });
    await order(buyer.id, { productId: 'bread', side: 'buy', qty: 40, priceCents: 2800, quality: 1 });
    await give(db, seller.id, 'bread', 2, 40);
    const res = await order(seller.id, { productId: 'bread', side: 'sell', qty: 40, priceCents: 2700, quality: 2 });
    expect(res.fills).toEqual([expect.objectContaining({ qty: 40, priceCents: 2800, quality: 2 })]);
    expect(await goods(db, buyer.id, 'bread', 2)).toBe(40);
    expect(await cash(db, buyer.id, 'escrow')).toBe(0);
  });

  it('never matches a company with itself', async () => {
    const c = await newCompany(db);
    await give(db, c.id, 'coal', 0, 100);
    await order(c.id, { productId: 'coal', side: 'sell', qty: 100, priceCents: 300, quality: 0 });
    const res = await order(c.id, { productId: 'coal', side: 'buy', qty: 100, priceCents: 300, quality: 0 });
    expect(res.fills).toEqual([]);
  });

  it('cancelling refunds escrow for bids and goods for asks', async () => {
    const c = await newCompany(db, { capital: 1_000_00 });
    const bid = await order(c.id, { productId: 'chip', side: 'buy', qty: 10, priceCents: 5000, quality: 0 });
    expect(await cash(db, c.id)).toBe(1_000_00 - 50_000);
    await withTx(db, (tx) => cancelOrder(tx, c.id, bid.orderId));
    expect(await cash(db, c.id)).toBe(1_000_00);
    expect(await cash(db, c.id, 'escrow')).toBe(0);

    await give(db, c.id, 'chip', 1, 5);
    const ask = await order(c.id, { productId: 'chip', side: 'sell', qty: 5, priceCents: 5300, quality: 1 });
    await withTx(db, (tx) => cancelOrder(tx, c.id, ask.orderId));
    expect(await goods(db, c.id, 'chip', 1)).toBe(5);
    await expect(withTx(db, (tx) => cancelOrder(tx, c.id, ask.orderId))).rejects.toMatchObject({ code: 'not_open' });
  });

  it('rejects prices outside 0.5×–2× reference and orders you cannot fund', async () => {
    const c = await newCompany(db, { capital: 100 });
    await expect(order(c.id, { productId: flourId, side: 'buy', qty: 1, priceCents: 399, quality: 0 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(order(c.id, { productId: flourId, side: 'buy', qty: 1, priceCents: 1601, quality: 0 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(order(c.id, { productId: flourId, side: 'buy', qty: 1, priceCents: 800, quality: 0 })).rejects.toMatchObject({ code: 'insufficient_funds' });
    await expect(order(c.id, { productId: flourId, side: 'sell', qty: 1, priceCents: 800, quality: 0 })).rejects.toMatchObject({ code: 'insufficient_goods' });
  });

  it('keeps the ledger closed after all of the above', async () => {
    expect(await ledgerTotal(db)).toEqual({ balances: 0, entries: 0 });
  });
});
