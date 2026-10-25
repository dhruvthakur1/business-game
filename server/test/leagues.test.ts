import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contestPoints, divisionFor, prizeCap, promoteCount, relegateCount, weeklyContests, DIVISIONS } from '../../shared/leagues';
import { computeMetric } from '../src/contestMetrics';
import { type Db, withTx } from '../src/db';
import { closeWeek, ensureMember, ensureWeek, groupStandings, leagueOverview, p90For } from '../src/leagues';
import { npcBuy, npcSell } from '../src/npc';
import { buyBuilding, collect, startJob } from '../src/production';
import { freshDb, give, newCompany } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

const member = async (week: number, companyId: string) => (await db.query('SELECT * FROM league_members WHERE week = $1 AND company_id = $2', [week, companyId])).rows[0];
const tier = async (companyId: string) => (await db.query('SELECT league_tier FROM companies WHERE id = $1', [companyId])).rows[0].league_tier;

/** Runs one farm cycle: 100 wheat for 152 CR of inputs → 298 CR value added. */
async function farmCycle(companyId: string, farmId?: string) {
  const id = farmId ?? (await withTx(db, (tx) => buyBuilding(tx, companyId, 'farm'))).id;
  await withTx(db, (tx) => npcBuy(tx, companyId, 'seeds', 60));
  await withTx(db, (tx) => npcBuy(tx, companyId, 'fertilizer', 20));
  await withTx(db, (tx) => startJob(tx, companyId, id));
  await db.query("UPDATE production_jobs SET finishes_at = now() - interval '1 second' WHERE building_id = $1 AND state = 'running'", [id]);
  await withTx(db, (tx) => collect(tx, companyId, { restart: false }));
  return id;
}

describe('rules', () => {
  it('assigns divisions by net worth', () => {
    expect(divisionFor(100_000).id).toBe('startup');
    expect(divisionFor(250_000).id).toBe('small');
    expect(divisionFor(5_000_000).id).toBe('mid');
    expect(divisionFor(300_000_000).id).toBe('conglomerate');
  });

  it('promotes 7 and relegates 5 of 30, scaled for small groups', () => {
    expect([promoteCount(30), relegateCount(30)]).toEqual([7, 5]);
    expect([promoteCount(10), relegateCount(10)]).toEqual([3, 1]);
    expect([promoteCount(1), relegateCount(1)]).toEqual([1, 0]);
  });

  it('normalizes points to the P90 and caps prizes', () => {
    expect(contestPoints(50, 100)).toBe(500);
    expect(contestPoints(500, 100)).toBe(1500);
    expect(contestPoints(10, 0)).toBe(0);
    expect(prizeCap(DIVISIONS[1], 1_000_000)).toBe(12_500); // min(25,000 × 0.5, 5% × 1,000,000)
    expect(prizeCap(DIVISIONS[1], 40_000)).toBe(2_000);
    expect(prizeCap(DIVISIONS[1], -5_000)).toBe(0);
  });

  it('rotates three distinct contests a week', () => {
    const w = weeklyContests(10);
    expect(new Set(w).size).toBe(3);
    expect(weeklyContests(11)).not.toEqual(w);
  });
});

describe('weeks and groups', () => {
  it('seats companies by division and tier and splits groups at 30', async () => {
    const w = await ensureWeek(db);
    const ids: string[] = [];
    for (let i = 0; i < 31; i++) ids.push((await newCompany(db, { capital: 50_000_00, level: 1 })).id);
    for (const id of ids) await withTx(db, (tx) => ensureMember(tx, id, w.week));
    const groups = await db.query("SELECT group_id, COUNT(*)::int AS n FROM league_members WHERE week = $1 AND division = 'startup' AND tier = 'Bronze' GROUP BY group_id ORDER BY n DESC", [w.week]);
    expect(groups.rows.map((g) => g.n)).toEqual([30, 1]);

    const rich = await newCompany(db, { capital: 5_000_000_00 });
    const m = await withTx(db, (tx) => ensureMember(tx, rich.id, w.week));
    expect(m).toMatchObject({ division: 'mid', tier: 'Bronze' });
    // Joining twice is a no-op.
    const again = await withTx(db, (tx) => ensureMember(tx, rich.id, w.week));
    expect(again!.group_id).toBe(m!.group_id);
  });

  it('ranks the Industry League by value added from collected jobs', async () => {
    const w = await ensureWeek(db);
    const a = await newCompany(db, { capital: 100_000_00, level: 1 });
    const b = await newCompany(db, { capital: 100_000_00, level: 1 });
    // Fresh tier so these two share a group of their own.
    await db.query("UPDATE companies SET league_tier = 'Gold' WHERE id IN ($1, $2)", [a.id, b.id]);
    const ma = await withTx(db, (tx) => ensureMember(tx, a.id, w.week));
    await withTx(db, (tx) => ensureMember(tx, b.id, w.week));
    const farm = await farmCycle(a.id);
    await farmCycle(a.id, farm);
    await farmCycle(b.id);
    const rows = await groupStandings(db, w, ma!.group_id, 'industry');
    // Each North farm cycle adds 110 × 4.50 − 152 = 343 CR.
    expect(rows.map((r) => [r.companyId, r.metric, r.rank])).toEqual([[a.id, 686, 1], [b.id, 343, 2]]);
    // Baseline P90 for a startup with no history is 25,000 CR.
    expect(rows[0].points).toBe(contestPoints(686, 25_000));
  });
});

describe('contest metrics', () => {
  const ctx = async (companyId: string, start = 0) => ({ companyId, from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 1000), division: DIVISIONS[0], startNetWorthCents: start });

  it('Harvest Sprint counts T1 units sold to NPCs per T1 level', async () => {
    const c = await newCompany(db, { capital: 100_000_00 });
    await withTx(db, (tx) => buyBuilding(tx, c.id, 'farm'));
    await give(db, c.id, 'wheat', 1, 900);
    await withTx(db, (tx) => npcSell(tx, c.id, 'wheat', 900, 1));
    const r = await computeMetric(db, 'harvest_sprint', await ctx(c.id));
    expect(r).toMatchObject({ metric: 900, eligible: true });
  });

  it('Quality Quest counts only Q2+ sales', async () => {
    const c = await newCompany(db);
    await give(db, c.id, 'bread', 2, 50);
    await give(db, c.id, 'bread', 1, 70);
    await withTx(db, (tx) => npcSell(tx, c.id, 'bread', 50, 2));
    await withTx(db, (tx) => npcSell(tx, c.id, 'bread', 70, 1));
    expect((await computeMetric(db, 'quality_quest', await ctx(c.id))).metric).toBe(50);
  });

  it('Margin Master needs 20,000 CR revenue', async () => {
    const c = await newCompany(db);
    await give(db, c.id, 'bread', 0, 100);
    await withTx(db, (tx) => npcSell(tx, c.id, 'bread', 100, 0));
    const r = await computeMetric(db, 'margin_master', await ctx(c.id));
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/20,000 CR revenue/);
  });

  it('Balance Sheet Builder scores growth since the week started', async () => {
    const c = await newCompany(db, { capital: 10_000_00 });
    await give(db, c.id, 'steel', 0, 100); // +2,400 CR of goods at reference
    const r = await computeMetric(db, 'balance_sheet', await ctx(c.id, 10_000_00));
    expect(r.metric).toBe(2400);
  });

  it('Reliable Supplier is ineligible below 3 unique buyers', async () => {
    const c = await newCompany(db);
    const r = await computeMetric(db, 'reliable_supplier', await ctx(c.id));
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/0 of 3 unique buyers/);
  });
});

describe('week close', () => {
  it('promotes, relegates, pays a capped prize, records trophies and learns the P90', async () => {
    // A clean week with one group of six in Silver/Startup.
    const w0 = await ensureWeek(db);
    await closeWeek(db, w0.week);
    const w = await ensureWeek(db);
    expect(w.week).toBe(w0.week + 1);

    const players: { id: string; token: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await newCompany(db, { capital: 100_000_00, level: 1 });
      await db.query("UPDATE companies SET league_tier = 'Silver' WHERE id = $1", [c.id]);
      await withTx(db, (tx) => ensureMember(tx, c.id, w.week));
      players.push(c);
    }
    // Players 0–4 produce (0 the most); player 5 does nothing.
    for (let i = 0; i < 5; i++) {
      let farm: string | undefined;
      for (let k = 0; k < 5 - i; k++) farm = await farmCycle(players[i].id, farm);
      // Positive operating cash flow so the division median (and prize cap) is above zero.
      await give(db, players[i].id, 'bread', 0, 2000);
      await withTx(db, (tx) => npcSell(tx, players[i].id, 'bread', 2000, 0));
    }

    const result = await closeWeek(db, w.week, new Date(Date.now() + 1000));
    expect(result.closed).toBe(true);
    // Group of 6: promote ceil(6 × 7/30) = 2, relegate floor(6 × 5/30) = 1.
    expect(await tier(players[0].id)).toBe('Gold');
    expect(await tier(players[1].id)).toBe('Gold');
    expect(await tier(players[2].id)).toBe('Silver');
    expect(await tier(players[5].id)).toBe('Bronze');
    const winner = await member(w.week, players[0].id);
    expect(winner).toMatchObject({ final_rank: 1, outcome: 'promoted' });
    expect(Number(winner.prize_cents)).toBeGreaterThan(0);
    expect(Number(winner.prize_cents)).toBeLessThanOrEqual(25_000 * 0.2 * 100);
    const trophies = await db.query('SELECT kind, title FROM trophies WHERE company_id = $1', [players[0].id]);
    expect(trophies.rows.some((t) => t.title.startsWith('Silver → Gold'))).toBe(true);
    // Closing twice does nothing.
    expect((await closeWeek(db, w.week)).closed).toBe(false);
    // Next week's P90 comes from these five real results instead of the baseline.
    const p90 = await p90For(db, 'industry', DIVISIONS[0], w.week + 1);
    expect(p90).toBeLessThan(25_000);
    expect(p90).toBeGreaterThan(298);
  });

  it('shows the overview with live gaps', async () => {
    const c = await newCompany(db, { capital: 100_000_00, level: 1 });
    await farmCycle(c.id);
    const o = await leagueOverview(db, c.id);
    expect(o.tier).toBe('Bronze');
    expect(o.division.id).toBe('startup');
    expect(o.contests).toHaveLength(3);
    expect(o.standings.find((s) => s.me)).toBeTruthy();
  });
});
