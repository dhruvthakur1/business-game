import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cycleOutput, opCostSplit, yieldMultiplier } from '../../shared/regions';
import { createCompany } from '../src/companies';
import { type Db, withTx } from '../src/db';
import { buyBuilding, startJob } from '../src/production';
import { freshDb, give } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

let n = 0;
const company = async (region: string) =>
  (await createCompany(db, { name: `Region Co ${region} ${++n}`, region, capitalCents: 1_000_000_00, level: 30 })).company.id;

describe('region rules', () => {
  it('gives each region its yield bonus', () => {
    expect(yieldMultiplier('north', 'farm')).toBe(1.1);
    expect(yieldMultiplier('east', 'farm')).toBe(1);
    expect(yieldMultiplier('east', 'iron_mine')).toBe(1.1);
    expect(yieldMultiplier('west', 'rnd_lab')).toBe(1.2);
    expect(cycleOutput(100, 3, 'north', 'farm')).toBe(330);
    expect(cycleOutput(25, 1, 'west', 'rnd_lab')).toBe(30);
  });

  it('splits op cost into wages (40% at index 1.0) and other costs', () => {
    expect(opCostSplit(100, 'north')).toEqual({ wages: 40, other: 60, total: 100 });
    expect(opCostSplit(100, 'south').total).toBeCloseTo(92);
    expect(opCostSplit(100, 'west').total).toBeCloseTo(112);
  });
});

describe('regions in production', () => {
  const runFarm = async (region: string) => {
    const id = await company(region);
    const farm = await withTx(db, (tx) => buyBuilding(tx, id, 'farm'));
    await give(db, id, 'seeds', 0, 60);
    await give(db, id, 'fertilizer', 0, 20);
    const job = await withTx(db, (tx) => startJob(tx, id, farm.id));
    const out = await db.query<{ output_qty: number }>("SELECT output_qty FROM production_jobs WHERE building_id = $1 AND state = 'running'", [farm.id]);
    const wages = await db.query<{ n: number }>(
      `SELECT COALESCE(SUM(e.amount_cents), 0)::int AS n FROM ledger_entries e JOIN ledger_txns t ON t.id = e.txn_id JOIN accounts a ON a.id = e.account_id
       WHERE a.company_id = $1 AND t.kind = 'wages'`,
      [id],
    );
    return { opCostCents: job.opCostCents, outputQty: out.rows[0].output_qty, wagesCents: -wages.rows[0].n };
  };

  it('charges wages by the home region and applies its yield bonus', async () => {
    // Farm op cost 120 CR: 48 wages + 72 other at index 1.0.
    expect(await runFarm('north')).toEqual({ opCostCents: 12_000, outputQty: 110, wagesCents: 4_800 });
    expect(await runFarm('east')).toEqual({ opCostCents: 12_000, outputQty: 100, wagesCents: 4_800 });
    expect(await runFarm('south')).toEqual({ opCostCents: 11_040, outputQty: 100, wagesCents: 3_840 });
    expect(await runFarm('west')).toEqual({ opCostCents: 13_440, outputQty: 100, wagesCents: 6_240 });
  });
});
