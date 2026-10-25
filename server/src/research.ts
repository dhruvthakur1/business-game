import { FAMILIES, type FamilyId, nextThreshold, RESEARCH_PRODUCT, RESEARCH_THRESHOLDS, researchTier } from '../../shared/research';
import type { Db, Tx } from './db';
import { badRequest } from './errors';
import { takeGoods } from './inventory';
import { awardXp } from './xp';

type Q = Pick<Tx, 'query'>;

/** XP for being the first company on the server to reach a family tier. */
export const FIRST_TO_TIER_XP = 500;

const FAMILY_IDS = FAMILIES.map((f) => f.id);
export const isFamily = (f: string): f is FamilyId => (FAMILY_IDS as string[]).includes(f);

export async function researchPoints(q: Q, companyId: string): Promise<Record<FamilyId, number>> {
  const res = await q.query<{ family: FamilyId; points: number }>('SELECT family, points FROM company_research WHERE company_id = $1', [companyId]);
  const out = Object.fromEntries(FAMILY_IDS.map((f) => [f, 0])) as Record<FamilyId, number>;
  for (const r of res.rows) out[r.family] = r.points;
  return out;
}

export async function familyTier(q: Q, companyId: string, family: FamilyId): Promise<number> {
  const res = await q.query<{ points: number }>('SELECT points FROM company_research WHERE company_id = $1 AND family = $2', [companyId, family]);
  return researchTier(res.rows[0]?.points ?? 0);
}

/**
 * Adds points to a family and handles any tiers crossed: the first company on the server to reach a tier
 * gets the innovation bonus. Returns the tiers newly reached.
 */
export async function addResearch(tx: Tx, companyId: string, family: FamilyId, points: number, source: 'lab' | 'applied') {
  if (points <= 0) return { points: 0, tiersReached: [] as number[], firsts: [] as number[] };
  const res = await tx.query<{ before: number; after: number }>(
    `INSERT INTO company_research (company_id, family, points) VALUES ($1, $2, $3)
     ON CONFLICT (company_id, family) DO UPDATE SET points = company_research.points + EXCLUDED.points
     RETURNING points - $3 AS before, points AS after`,
    [companyId, family, points],
  );
  await tx.query('INSERT INTO research_log (company_id, family, points, source) VALUES ($1, $2, $3, $4)', [companyId, family, points, source]);
  const { before, after } = res.rows[0];
  const tiersReached: number[] = [];
  for (let t = researchTier(before) + 1; t <= researchTier(after); t++) tiersReached.push(t);

  const isNpc = (await tx.query<{ is_npc: boolean }>('SELECT is_npc FROM companies WHERE id = $1', [companyId])).rows[0].is_npc;
  const firsts: number[] = [];
  if (!isNpc) {
    for (const t of tiersReached) {
      const ins = await tx.query('INSERT INTO research_firsts (family, tier, company_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [family, t, companyId]);
      if (ins.rowCount) {
        firsts.push(t);
        const name = FAMILIES.find((f) => f.id === family)!.name;
        await awardXp(tx, companyId, 'research', FIRST_TO_TIER_XP, { note: `First to ${name} Q${t}` });
      }
    }
  }
  return { points, tiersReached, firsts };
}

export async function setFocus(tx: Tx, companyId: string, family: string | null) {
  if (family !== null && !isFamily(family)) throw badRequest('Unknown research family.');
  await tx.query('UPDATE companies SET research_focus = $2 WHERE id = $1', [companyId, family]);
  return { focus: family };
}

/** Spends research points from the warehouse (made by labs or bought on the exchange) on a family. */
export async function applyPoints(tx: Tx, companyId: string, family: string, points: number) {
  if (!isFamily(family)) throw badRequest('Unknown research family.');
  if (!Number.isInteger(points) || points <= 0 || points > 1_000_000) throw badRequest('Points must be a positive whole number.');
  await takeGoods(tx, companyId, RESEARCH_PRODUCT, 0, points);
  return addResearch(tx, companyId, family, points, 'applied');
}

export async function researchView(db: Db, companyId: string) {
  const [points, company, labs, onHand, rank, firsts, recent] = await Promise.all([
    researchPoints(db, companyId),
    db.query<{ research_focus: FamilyId | null }>('SELECT research_focus FROM companies WHERE id = $1', [companyId]),
    db.query<{ id: string; name: string; level: number; cycle_minutes: number; qty: number; running: boolean }>(
      `SELECT b.id, b.name, b.level, bt.cycle_minutes, rl.qty,
              EXISTS (SELECT 1 FROM production_jobs j WHERE j.building_id = b.id AND j.state = 'running') AS running
       FROM buildings b JOIN building_types bt ON bt.id = b.building_type_id
       JOIN recipe_lines rl ON rl.building_type_id = bt.id AND rl.direction = 'out' AND rl.product_id = $2
       WHERE b.company_id = $1 ORDER BY b.plot`,
      [companyId, RESEARCH_PRODUCT],
    ),
    db.query<{ qty: number }>('SELECT COALESCE(SUM(qty), 0)::int AS qty FROM inventory WHERE company_id = $1 AND product_id = $2', [companyId, RESEARCH_PRODUCT]),
    db.query<{ rank: number; total: number; of: number }>(
      `WITH totals AS (
         SELECT c.id, COALESCE(SUM(r.points), 0) AS total FROM companies c LEFT JOIN company_research r ON r.company_id = c.id
         WHERE NOT c.is_npc GROUP BY c.id)
       SELECT (SELECT count(*) FROM totals t2 WHERE t2.total > t.total)::int + 1 AS rank, t.total::int AS total,
              (SELECT count(*) FROM totals)::int AS of
       FROM totals t WHERE t.id = $1`,
      [companyId],
    ),
    db.query<{ family: FamilyId; tier: number; company_id: string; name: string; reached_at: Date }>(
      'SELECT f.family, f.tier, f.company_id, c.name, f.reached_at FROM research_firsts f JOIN companies c ON c.id = f.company_id',
    ),
    db.query<{ family: FamilyId; points: number; source: string; created_at: Date }>(
      'SELECT family, points, source, created_at FROM research_log WHERE company_id = $1 ORDER BY id DESC LIMIT 8',
      [companyId],
    ),
  ]);
  const rpPerDay = labs.rows.reduce((s, l) => s + l.qty * l.level * ((24 * 60) / l.cycle_minutes), 0);
  return {
    thresholds: RESEARCH_THRESHOLDS,
    focus: company.rows[0].research_focus,
    rpOnHand: onHand.rows[0].qty,
    rpPerDay: labs.rows.length ? rpPerDay : 0,
    labs: labs.rows.map((l) => ({ id: l.id, name: l.name, level: l.level, running: l.running, rpPerCycle: l.qty * l.level })),
    innovation: { rank: rank.rows[0]?.rank ?? 1, of: rank.rows[0]?.of ?? 1, totalPoints: rank.rows[0]?.total ?? 0, firstBonusXp: FIRST_TO_TIER_XP },
    families: FAMILIES.map((f) => ({
      id: f.id,
      name: f.name,
      points: points[f.id],
      tier: researchTier(points[f.id]),
      next: nextThreshold(points[f.id]),
      planned: f.planned,
      firsts: firsts.rows
        .filter((x) => x.family === f.id)
        .map((x) => ({ tier: x.tier, companyName: x.name, mine: x.company_id === companyId, at: x.reached_at.toISOString() })),
    })),
    recent: recent.rows.map((r) => ({ family: r.family, points: r.points, source: r.source, at: r.created_at.toISOString() })),
  };
}
