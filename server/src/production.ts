import { PLOTS_PER_COMPANY } from '../../shared/catalog';
import { adminOverhead, outputQuality, upgradeCost } from '../../shared/economy';
import { gameMinutesToMs } from './config';
import type { Db, Tx } from './db';
import { badRequest, conflict, GameError, notFound } from './errors';
import { addGoods, bestLot, takeGoods } from './inventory';
import { companyAccount, systemAccount, transfer } from './ledger';
import { loadBuildingType } from './catalog';
import { awardXp } from './xp';
import { XP_PER_CR_VALUE_ADD } from '../../shared/levels';
import { BUILDING_FAMILY, RESEARCH_PRODUCT, researchBonus } from '../../shared/research';
import { VARIANT_TIERS, variantInputQty, type VariantTier } from '../../shared/designer';
import { addResearch, familyTier } from './research';
import { settleShelfJob, startShelfJob } from './retail';

export interface BuildingView {
  id: string;
  typeId: string;
  name: string;
  level: number;
  plot: number;
  /** Design (branded product) the building makes instead of its normal output. */
  designId: string | null;
  job: null | {
    id: string;
    startedAt: string;
    finishesAt: string;
    outputProduct: string | null;
    outputQty: number;
    outputQuality: number;
  };
}

export async function buyBuilding(tx: Tx, companyId: string, typeId: string, plot?: number) {
  const type = await loadBuildingType(tx, typeId);
  const company = await tx.query<{ level: number }>('SELECT level FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (company.rows[0].level < type.unlockLevel) {
    throw conflict('locked', `${type.name} unlocks at company level ${type.unlockLevel}.`);
  }
  const used = new Set((await tx.query<{ plot: number }>('SELECT plot FROM buildings WHERE company_id = $1', [companyId])).rows.map((r) => r.plot));
  let target = plot;
  if (target === undefined) {
    target = [...Array(PLOTS_PER_COMPANY).keys()].find((p) => !used.has(p));
    if (target === undefined) throw conflict('no_plots', 'All plots are in use.');
  } else if (target < 0 || target >= PLOTS_PER_COMPANY || used.has(target)) {
    throw badRequest('That plot is not available.');
  }
  const sameType = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM buildings WHERE company_id = $1 AND building_type_id = $2', [companyId, typeId]);
  const name = sameType.rows[0].n > 0 ? `${type.name} ${sameType.rows[0].n + 1}` : type.name;

  const cash = await companyAccount(tx, companyId, 'cash');
  const sink = await systemAccount(tx, 'sink:construction');
  await transfer(tx, 'building_purchase', `Built ${name}`, cash, sink, type.buildCostCents);
  const res = await tx.query<{ id: string }>(
    'INSERT INTO buildings (company_id, building_type_id, name, plot) VALUES ($1, $2, $3, $4) RETURNING id',
    [companyId, typeId, name, target],
  );
  return { id: res.rows[0].id, name, plot: target };
}

async function lockBuilding(tx: Tx, companyId: string, buildingId: string) {
  const res = await tx.query<{ id: string; building_type_id: string; level: number; name: string; design_id: string | null }>(
    'SELECT id, building_type_id, level, name, design_id FROM buildings WHERE id = $1 AND company_id = $2 FOR UPDATE',
    [buildingId, companyId],
  );
  if (!res.rows[0]) throw notFound('Building');
  return res.rows[0];
}

/**
 * Starts one production cycle: reserves inputs (removing them from the warehouse), charges the
 * operating cost and schedules the output for finishes_at. Outputs are settled lazily by collect().
 */
export async function startJob(tx: Tx, companyId: string, buildingId: string, opts: { inputQuality?: number } = {}) {
  const b = await lockBuilding(tx, companyId, buildingId);
  const type = await loadBuildingType(tx, b.building_type_id);
  const arrears = await tx.query<{ upkeep_arrears_cents: number }>('SELECT upkeep_arrears_cents FROM companies WHERE id = $1', [companyId]);
  if (Number(arrears.rows[0].upkeep_arrears_cents) > 0) {
    throw conflict('upkeep_arrears', 'Production is paused until unpaid upkeep is settled.');
  }
  const isShelf = type.id === 'supermarket';
  if (type.outputs.length === 0 && !isShelf) throw conflict('not_producer', `${type.name} does not run production jobs.`);

  const running = await tx.query<{ finishes_at: Date }>("SELECT finishes_at FROM production_jobs WHERE building_id = $1 AND state = 'running'", [b.id]);
  if (running.rows[0]) {
    const done = running.rows[0].finishes_at.getTime() <= Date.now();
    throw conflict('busy', done ? 'Collect the finished job first.' : `${b.name} is already running a job.`);
  }
  // A supermarket cycle stocks the shelf instead of consuming a recipe.
  if (isShelf) return startShelfJob(tx, companyId, b.id, type);

  // A building set to a design runs the same recipe with more inputs, pays for materials and makes the design.
  const design = b.design_id
    ? (await tx.query<{ product_id: string; tier: VariantTier; materials_cents: number }>(
        'SELECT product_id, tier, materials_cents FROM designs WHERE product_id = $1',
        [b.design_id],
      )).rows[0]
    : undefined;

  const qualities: number[] = [];
  let inputValue = 0;
  for (const [i, input] of type.inputs.entries()) {
    const need = design ? variantInputQty(input.qty, b.level, design.tier) : input.qty * b.level;
    const q = i === 0 && opts.inputQuality !== undefined ? opts.inputQuality : await bestLot(tx, companyId, input.productId, need);
    if (q === null) throw conflict('missing_inputs', `Needs ${need} ${input.productId.replace('_', ' ')} in the warehouse.`);
    await takeGoods(tx, companyId, input.productId, q, need);
    qualities.push(q);
    inputValue += need * (await basePrice(tx, input.productId));
  }
  const out = type.outputs[0];
  const family = BUILDING_FAMILY[type.id];
  const mean = qualities.length ? qualities.reduce((a, x) => a + x, 0) / qualities.length : 0;
  const bonus = family ? researchBonus(await familyTier(tx, companyId, family), mean) : 0;
  // Research points have no quality.
  const outQ = out.productId === RESEARCH_PRODUCT ? 0 : outputQuality(qualities, bonus);

  const levels = await tx.query<{ total: number }>('SELECT COALESCE(SUM(level), 0)::int AS total FROM buildings WHERE company_id = $1', [companyId]);
  const opCost = Math.round(type.opCostCents * b.level * adminOverhead(levels.rows[0].total));
  const cash = await companyAccount(tx, companyId, 'cash');
  const sink = await systemAccount(tx, 'sink:operations');
  await transfer(tx, 'op_cost', `${b.name}: operating cost`, cash, sink, opCost);
  if (design) {
    const materials = Math.round(Number(design.materials_cents) * VARIANT_TIERS[design.tier].inputMult * out.qty * b.level);
    await transfer(tx, 'op_cost', `${b.name}: design materials`, cash, await systemAccount(tx, 'sink:materials'), materials);
    inputValue += materials;
  }

  const outProduct = design?.product_id ?? out.productId;
  const now = new Date();
  const finishes = new Date(now.getTime() + gameMinutesToMs(type.cycleMinutes));
  const job = await tx.query<{ id: string }>(
    `INSERT INTO production_jobs (building_id, started_at, finishes_at, state, output_product, output_qty, output_quality, input_quality, input_value_cents)
     VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $8) RETURNING id`,
    [b.id, now, finishes, outProduct, out.qty * b.level, outQ, qualities[0] ?? 0, inputValue],
  );
  return { jobId: job.rows[0].id, finishesAt: finishes.toISOString(), outputQuality: outQ, opCostCents: opCost };
}

export interface Collected {
  buildingId: string;
  productId: string;
  qty: number;
  quality: number;
  /** Set when research points went straight to the lab's focus family instead of the warehouse. */
  researchFamily?: string;
  /** Supermarket cycles: units sold to shoppers and what they paid (unsold units go back to the warehouse). */
  retail?: { sold: number; unsold: number; proceedsCents: number };
  restarted: boolean;
  restartError?: string;
  xp: number;
}

async function basePrice(tx: Tx, productId: string): Promise<number> {
  return (await tx.query<{ p: number }>('SELECT ref_price_cents AS p FROM products WHERE id = $1', [productId])).rows[0].p;
}

/**
 * Settles every finished job (optionally only the given buildings). Idempotent: a job moves from
 * running to collected exactly once, so repeated calls never double-credit goods.
 */
export async function collect(tx: Tx, companyId: string, opts: { buildingIds?: string[]; restart?: boolean } = {}): Promise<Collected[]> {
  const res = await tx.query<{ id: string; building_id: string; output_product: string; output_qty: number; output_quality: number; input_quality: number; input_value_cents: number; retail_price_cents: number | null }>(
    `UPDATE production_jobs j SET state = 'collected', collected_at = now()
     FROM buildings b
     WHERE j.building_id = b.id AND b.company_id = $1 AND j.state = 'running' AND j.finishes_at <= now()
       AND ($2::uuid[] IS NULL OR b.id = ANY($2::uuid[]))
     RETURNING j.id, j.building_id, j.output_product, j.output_qty, j.output_quality, j.input_quality, j.input_value_cents, j.retail_price_cents`,
    [companyId, opts.buildingIds ?? null],
  );
  const out: Collected[] = [];
  const focus = (await tx.query<{ research_focus: string | null }>('SELECT research_focus FROM companies WHERE id = $1', [companyId])).rows[0].research_focus;
  for (const row of res.rows) {
    if (row.retail_price_cents !== null) {
      const r = await settleShelfJob(tx, companyId, { ...row, retail_price_cents: row.retail_price_cents });
      const item: Collected = { buildingId: row.building_id, productId: row.output_product, qty: row.output_qty, quality: row.output_quality, retail: { sold: r.sold, unsold: r.unsold, proceedsCents: r.proceedsCents }, restarted: false, xp: r.xp };
      if (opts.restart) await restartJob(tx, companyId, row.building_id, item);
      out.push(item);
      continue;
    }
    const toFocus = row.output_product === RESEARCH_PRODUCT && focus !== null;
    if (toFocus) await addResearch(tx, companyId, focus as Parameters<typeof addResearch>[2], row.output_qty, 'lab');
    else await addGoods(tx, companyId, row.output_product, row.output_quality, row.output_qty);
    // XP for value added: output minus inputs, both at base reference prices.
    const valueAdd = row.output_qty * (await basePrice(tx, row.output_product)) - Number(row.input_value_cents);
    await tx.query('UPDATE production_jobs SET value_add_cents = $2 WHERE id = $1', [row.id, valueAdd]);
    const xp = await awardXp(tx, companyId, 'production', (valueAdd / 100) * XP_PER_CR_VALUE_ADD, { note: `${row.output_qty} ${row.output_product.replace('_', ' ')} produced` });
    const item: Collected = { buildingId: row.building_id, productId: row.output_product, qty: row.output_qty, quality: row.output_quality, restarted: false, xp: xp.awarded };
    if (toFocus) item.researchFamily = focus!;
    if (opts.restart) await restartJob(tx, companyId, row.building_id, item);
    out.push(item);
  }
  return out;
}

/** Tries to start the next cycle; a game error (no inputs, no cash) is reported, not thrown. */
async function restartJob(tx: Tx, companyId: string, buildingId: string, item: Collected) {
  await tx.query('SAVEPOINT restart');
  try {
    await startJob(tx, companyId, buildingId, {});
    await tx.query('RELEASE SAVEPOINT restart');
    item.restarted = true;
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT restart');
    if (!(err instanceof GameError)) throw err;
    item.restartError = err.message;
  }
}

export async function upgradeBuilding(tx: Tx, companyId: string, buildingId: string) {
  const b = await lockBuilding(tx, companyId, buildingId);
  const type = await loadBuildingType(tx, b.building_type_id);
  const cost = Math.round(upgradeCost(type.buildCostCents, b.level + 1));
  const cash = await companyAccount(tx, companyId, 'cash');
  const sink = await systemAccount(tx, 'sink:upgrades');
  await transfer(tx, 'building_upgrade', `${b.name} → Lv ${b.level + 1}`, cash, sink, cost);
  await tx.query('UPDATE buildings SET level = level + 1 WHERE id = $1', [b.id]);
  return { level: b.level + 1, costCents: cost };
}

export async function listBuildings(db: Db | Tx, companyId: string): Promise<BuildingView[]> {
  const res = await db.query(
    `SELECT b.id, b.building_type_id, b.name, b.level, b.plot, b.design_id,
            j.id AS job_id, j.started_at, j.finishes_at, j.output_product, j.output_qty, j.output_quality
     FROM buildings b
     LEFT JOIN production_jobs j ON j.building_id = b.id AND j.state = 'running'
     WHERE b.company_id = $1 ORDER BY b.plot`,
    [companyId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    typeId: r.building_type_id,
    name: r.name,
    level: r.level,
    plot: r.plot,
    designId: r.design_id,
    job: r.job_id
      ? {
          id: r.job_id,
          startedAt: (r.started_at as Date).toISOString(),
          finishesAt: (r.finishes_at as Date).toISOString(),
          outputProduct: r.output_product,
          outputQty: r.output_qty,
          outputQuality: r.output_quality,
        }
      : null,
  }));
}

/** Points a building at one of the company's designs (or back to its normal recipe). Takes effect next cycle. */
export async function setBuildingDesign(tx: Tx, companyId: string, buildingId: string, designId: string | null) {
  const b = await lockBuilding(tx, companyId, buildingId);
  if (designId !== null) {
    const d = (await tx.query<{ building_type_id: string; company_id: string }>(
      'SELECT d.building_type_id, br.company_id FROM designs d JOIN brands br ON br.id = d.brand_id WHERE d.product_id = $1',
      [designId],
    )).rows[0];
    if (!d || d.company_id !== companyId) throw notFound('Design');
    if (d.building_type_id !== b.building_type_id) throw conflict('wrong_building', 'That design is made in a different building.');
  }
  await tx.query('UPDATE buildings SET design_id = $2 WHERE id = $1', [b.id, designId]);
  return { buildingId: b.id, designId };
}
