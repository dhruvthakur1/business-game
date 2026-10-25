import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freightCost, hops, transitHours } from '../../shared/regions';
import { createCompany } from '../src/companies';
import { type Db, withTx } from '../src/db';
import { placeOrder } from '../src/exchange';
import { deliverShipments, incomingShipments } from '../src/shipping';
import { assetsCents } from '../src/state';
import { cash, freshDb, give, goods, ledgerTotal } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

let n = 0;
const company = async (region: string, capitalCents = 1_000_000_00) =>
  (await createCompany(db, { name: `Freight Co ${region} ${++n}`, region, capitalCents, level: 30 })).company.id;

describe('freight rules', () => {
  it('counts hops around the square of regions', () => {
    expect(hops('north', 'north')).toBe(0);
    expect(hops('north', 'east')).toBe(1);
    expect(hops('north', 'south')).toBe(2);
    expect(hops('east', 'west')).toBe(2);
  });

  it('prices freight at 0.02 CR per unit-weight-hop, a quarter hop locally, half through the South', () => {
    expect(freightCost(100, 1, 'north', 'north')).toBeCloseTo(0.5);
    expect(freightCost(100, 2, 'north', 'east')).toBeCloseTo(4);
    expect(freightCost(100, 1, 'north', 'south')).toBeCloseTo(2); // 2 hops × 0.02 × 100 = 4, halved
    expect(freightCost(100, 0, 'north', 'west')).toBe(0);
  });

  it('takes 1 hour locally and 4 hours per hop; weightless goods are instant', () => {
    expect(transitHours(1, 'north', 'north')).toBe(1);
    expect(transitHours(1, 'north', 'east')).toBe(4);
    expect(transitHours(1, 'east', 'west')).toBe(8);
    expect(transitHours(0, 'east', 'west')).toBe(0);
  });
});

describe('shipping exchange trades', () => {
  it('ships across regions, charges the seller and lands goods when they arrive', async () => {
    const seller = await company('north', 0);
    const buyer = await company('east');
    await give(db, seller, 'steel', 0, 100);
    await withTx(db, (tx) => placeOrder(tx, seller, { productId: 'steel', side: 'sell', qty: 100, priceCents: 2400, quality: 0 }));
    const res = await withTx(db, (tx) => placeOrder(tx, buyer, { productId: 'steel', side: 'buy', qty: 100, priceCents: 2400, quality: 0 }));

    // 100 steel × weight 2 × 1 hop × 2 cents = 4 CR, taken from the seller's proceeds.
    expect(res.fills[0].freightCents).toBe(400);
    expect(await cash(db, seller)).toBe(100 * 2400 - 4800 - 400);
    const incoming = await incomingShipments(db, buyer);
    expect(incoming).toEqual([expect.objectContaining({ productId: 'steel', qty: 100, fromRegion: 'north', source: 'trade' })]);
    const hoursAway = (Date.parse(incoming[0].arrivesAt) - Date.now()) / 3_600_000;
    expect(hoursAway).toBeGreaterThan(3.9);

    // Still company assets while in transit.
    expect(await assetsCents(db, buyer)).toBeGreaterThan(1_000_000_00 - 240_000 - 1);

    expect(await deliverShipments(db)).toBe(0); // not there yet
    expect(await goods(db, buyer, 'steel', 0)).toBe(0);
    expect(await deliverShipments(db, { now: new Date(Date.now() + 5 * 3_600_000) })).toBe(1);
    expect(await goods(db, buyer, 'steel', 0)).toBe(100);
    expect(await deliverShipments(db, { now: new Date(Date.now() + 5 * 3_600_000) })).toBe(0); // exactly once
    expect((await ledgerTotal(db)).balances).toBe(0);
  });

  it('delivers weightless goods instantly and free', async () => {
    const seller = await company('west', 0);
    const buyer = await company('east');
    await give(db, seller, 'mwh', 0, 10);
    await withTx(db, (tx) => placeOrder(tx, seller, { productId: 'mwh', side: 'sell', qty: 10, priceCents: 4000, quality: 0 }));
    const res = await withTx(db, (tx) => placeOrder(tx, buyer, { productId: 'mwh', side: 'buy', qty: 10, priceCents: 4000, quality: 0 }));
    expect(res.fills[0].freightCents).toBe(0);
    expect(await goods(db, buyer, 'mwh', 0)).toBe(10);
  });
});
