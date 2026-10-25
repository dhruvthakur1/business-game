import { fileURLToPath } from 'node:url';
import { BUILDING_TYPE_DEFS, PRODUCT_DEFS } from '../../shared/catalog';
import { createCompany } from './companies';
import { acceptContract, offerContract } from './contracts';
import { createPool, type Db, withTx } from './db';
import { placeOrder } from './exchange';
import { addGoods } from './inventory';
import { toCents } from './ledger';
import { npcSell } from './npc';
import { buyBuilding, setBuildingDesign, startJob } from './production';
import { createDesign } from './brands';

/** Upserts products, building types and recipes from shared/catalog.ts. Safe to run repeatedly. */
export async function upsertCatalog(db: Db) {
  await withTx(db, async (tx) => {
    for (const p of PRODUCT_DEFS) {
      await tx.query(
        `INSERT INTO products (id, name, tier, ref_price_cents, unit, npc_vendor) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET name = $2, tier = $3, ref_price_cents = $4, unit = $5, npc_vendor = $6`,
        [p.id, p.name, p.tier, toCents(p.refPrice), p.unit ?? null, p.npcVendor ?? false],
      );
    }
    for (const t of BUILDING_TYPE_DEFS) {
      await tx.query(
        `INSERT INTO building_types (id, name, tag, build_cost_cents, unlock_level, cycle_minutes, op_cost_cents, upkeep_per_day_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET name = $2, tag = $3, build_cost_cents = $4, unlock_level = $5, cycle_minutes = $6, op_cost_cents = $7, upkeep_per_day_cents = $8`,
        [t.id, t.name, t.tag, toCents(t.buildCost), t.unlockLevel, t.cycleHours * 60, toCents(t.opCost), toCents(t.upkeepPerDay)],
      );
      await tx.query('DELETE FROM recipe_lines WHERE building_type_id = $1', [t.id]);
      for (const l of t.inputs) await tx.query("INSERT INTO recipe_lines VALUES ($1, $2, 'in', $3)", [t.id, l.productId, l.qty]);
      for (const l of t.outputs) await tx.query("INSERT INTO recipe_lines VALUES ($1, $2, 'out', $3)", [t.id, l.productId, l.qty]);
    }
  });
}

/** Market makers give the exchange depth so a fresh server is playable. */
const MAKERS: { name: string; goods: [string, number, number][] }[] = [
  { name: 'Ferro Labs', goods: [['steel', 0, 4000], ['iron_ore', 1, 6000], ['mwh', 0, 400], ['chip', 1, 600]] },
  { name: 'Harbor Bakeries', goods: [['flour', 1, 5000], ['flour', 2, 2000], ['bread', 1, 2000], ['wheat', 0, 6000]] },
  { name: 'Ridgeback Mining', goods: [['iron_ore', 0, 9000], ['coal', 0, 8000], ['glass', 0, 1500], ['silicon_wafer', 0, 800]] },
  { name: 'Saltmarsh Foods', goods: [['wheat', 1, 8000], ['wheat', 2, 3000], ['cotton', 0, 4000], ['fabric', 1, 1500]] },
];

const ref = (id: string) => PRODUCT_DEFS.find((p) => p.id === id)!.refPrice;
const cents = (cr: number) => Math.round(cr * 100);

export async function seedWorld(db: Db) {
  await upsertCatalog(db);
  const existing = await db.query("SELECT 1 FROM companies WHERE name = 'Northwind Holdings'");
  if (existing.rowCount) {
    await seedResearchAndBrands(db);
    console.log('World already seeded; catalog refreshed.');
    return;
  }

  for (const m of MAKERS) {
    const { company } = await createCompany(db, { name: m.name, isNpc: true, capitalCents: toCents(5_000_000), level: 30 });
    await withTx(db, async (tx) => {
      for (const [productId, quality, qty] of m.goods) {
        await addGoods(tx, company.id, productId, quality, qty);
        const p = ref(productId);
        // Asks a little above reference, bids a little below, in three levels each.
        for (const [i, k] of [1.01, 1.03, 1.06].entries()) {
          await placeOrder(tx, company.id, { productId, side: 'sell', qty: Math.floor(qty / (6 + i * 2)), priceCents: cents(p * k), quality });
        }
        for (const k of [0.99, 0.97, 0.94]) {
          await placeOrder(tx, company.id, { productId, side: 'buy', qty: Math.floor(qty / 8), priceCents: cents(p * k), quality: 0 });
        }
      }
    });
  }

  // Demo player company matching the design mocks.
  const { company } = await createCompany(db, { name: 'Northwind Holdings', region: 'north', capitalCents: toCents(800_000), level: 12 });
  await withTx(db, async (tx) => {
    const lots: [string, number, number][] = [
      ['seeds', 0, 900], ['fertilizer', 0, 300], ['wheat', 0, 1800], ['wheat', 1, 900], ['wheat', 2, 600],
      ['flour', 1, 480], ['coal', 0, 400], ['water', 0, 800], ['iron_ore', 0, 300], ['mwh', 0, 40], ['bread', 1, 600],
    ];
    for (const [p, q, n] of lots) await addGoods(tx, company.id, p, q, n);

    const plan: { type: string; level: number; start: boolean; finished?: boolean }[] = [
      { type: 'farm', level: 4, start: true, finished: true },
      { type: 'farm', level: 3, start: true },
      { type: 'mill', level: 3, start: true },
      { type: 'iron_mine', level: 1, start: false },
      { type: 'bakery', level: 3, start: true, finished: true },
      { type: 'supermarket', level: 2, start: false },
      { type: 'power_plant', level: 2, start: true },
      { type: 'steel_mill', level: 1, start: true, finished: true },
    ];
    for (const b of plan) {
      const built = await buyBuilding(tx, company.id, b.type);
      await tx.query('UPDATE buildings SET level = $2 WHERE id = $1', [built.id, b.level]);
      if (b.start) {
        await startJob(tx, company.id, built.id);
        if (b.finished) {
          await tx.query("UPDATE production_jobs SET finishes_at = now() - interval '1 second' WHERE building_id = $1 AND state = 'running'", [built.id]);
        }
      }
    }
    // A month of history so the bank has something to lend against: the company is 30 game days old
    // and has recent NPC sales on its books.
    await tx.query('UPDATE companies SET created_day = created_day - 30, xp = xp + 7200 WHERE id = $1', [company.id]);
    await npcSell(tx, company.id, 'wheat', 1500, 0);
    await npcSell(tx, company.id, 'bread', 600, 1);
  });
  // Contracts: an active flour supply deal, and an incoming offer waiting for an answer.
  const npc = async (name: string) => (await db.query<{ id: string }>('SELECT id FROM companies WHERE name = $1', [name])).rows[0].id;
  const harbor = await npc('Harbor Bakeries');
  const ferro = await npc('Ferro Labs');
  await withTx(db, async (tx) => {
    const flour = await offerContract(tx, harbor, {
      counterpartyId: company.id, role: 'buy',
      terms: { productId: 'flour', qty: 240, minQuality: 1, priceCents: 820, frequencyHours: 24, windowHours: 24, termDays: 14 },
    });
    await acceptContract(tx, company.id, flour.contractId);
    await offerContract(tx, ferro, {
      counterpartyId: company.id, role: 'buy',
      terms: { productId: 'mwh', qty: 15, minQuality: 0, priceCents: 4100, frequencyHours: 24, windowHours: 24, termDays: 7 },
    });
  });
  await seedResearchAndBrands(db);
  console.log('Seeded catalog, 4 market makers and the Northwind Holdings demo company.');
}

/**
 * Demo research and brands for Northwind: an R&D Lab focused on Food, some points in four families, and two
 * brands with a premium bread design the bakery is making. Skipped if Northwind already has a brand.
 */
export async function seedResearchAndBrands(db: Db) {
  const nw = (await db.query<{ id: string }>("SELECT id FROM companies WHERE name = 'Northwind Holdings' AND NOT is_npc")).rows[0];
  if (!nw) return;
  if ((await db.query('SELECT 1 FROM brands WHERE company_id = $1', [nw.id])).rowCount) return;
  await withTx(db, async (tx) => {
    const lab = await buyBuilding(tx, nw.id, 'rnd_lab');
    await tx.query('UPDATE buildings SET level = 2 WHERE id = $1', [lab.id]);
    await addGoods(tx, nw.id, 'mwh', 0, 20);
    await startJob(tx, nw.id, lab.id);
    await tx.query("UPDATE companies SET research_focus = 'food' WHERE id = $1", [nw.id]);
    for (const [family, points] of [['agri', 1620], ['food', 410], ['metals', 260], ['energy', 90]] as const) {
      await tx.query(
        'INSERT INTO company_research (company_id, family, points) VALUES ($1, $2, $3) ON CONFLICT (company_id, family) DO NOTHING',
        [nw.id, family, points],
      );
    }
    await addGoods(tx, nw.id, 'research_points', 0, 320);

    const brand = async (name: string, logo: number, rep: number) =>
      (await tx.query<{ id: string }>(
        'INSERT INTO brands (company_id, name, name_key, logo, reputation) VALUES ($1, $2, lower($2), $3, $4) RETURNING id',
        [nw.id, name, logo, rep],
      )).rows[0].id;
    await brand('Northwind Atelier', 0, 64);
    const bakehouse = await brand('Fieldline Bakehouse', 1, 41);
    const loaf = await createDesign(tx, nw.id, { brandId: bakehouse, templateId: 'loaf', slots: { grain: 1, finish: 1 }, tier: 'premium', priceCents: 4400 });
    const bakery = (await tx.query<{ id: string }>("SELECT id FROM buildings WHERE company_id = $1 AND building_type_id = 'bakery' LIMIT 1", [nw.id])).rows[0];
    if (bakery) await setBuildingDesign(tx, nw.id, bakery.id, loaf.productId);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = createPool();
  seedWorld(db)
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}
