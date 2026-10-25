import { randomBytes } from 'node:crypto';
import {
  BRAND_RULES, brandKey, brandNameProblem, type DesignChoice, designArt, designEconomics, designName,
  nextReputation, pickedOptions, templateById, VARIANT_TIERS, type VariantTier,
} from '../../shared/designer';
import type { Db, Tx } from './db';
import { badRequest, conflict, notFound } from './errors';
import { companyAccount, systemAccount, toCents, transfer } from './ledger';
import { gameDayStart } from './time';

type Q = Pick<Tx, 'query'>;

/** Null when the name can be registered, otherwise why not. */
export async function brandNameStatus(q: Q, name: string): Promise<string | null> {
  const problem = brandNameProblem(name);
  if (problem) return problem;
  const taken = await q.query('SELECT 1 FROM brands WHERE name_key = $1', [brandKey(name)]);
  return taken.rowCount ? 'That name is taken. Brand names are unique across the server.' : null;
}

export async function registerBrand(tx: Tx, companyId: string, input: { name: string; logo: number }) {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!Number.isInteger(input.logo) || input.logo < 0 || input.logo >= BRAND_RULES.logoCount) throw badRequest('Pick one of the logos.');
  await tx.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  const count = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM brands WHERE company_id = $1', [companyId])).rows[0].n;
  if (count >= BRAND_RULES.maxPerCompany) throw conflict('brand_limit', `A company can own at most ${BRAND_RULES.maxPerCompany} brands.`);
  const problem = await brandNameStatus(tx, name);
  if (problem) throw conflict('brand_name', problem);

  const cash = await companyAccount(tx, companyId, 'cash');
  await transfer(tx, 'brand_registration', `Registered brand ${name}`, cash, await systemAccount(tx, 'sink:brands'), toCents(BRAND_RULES.fee));
  try {
    await tx.query('SAVEPOINT brand');
    const res = await tx.query<{ id: string }>(
      'INSERT INTO brands (company_id, name, name_key, logo, reputation) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [companyId, name, brandKey(name), input.logo, BRAND_RULES.startingReputation],
    );
    await tx.query('RELEASE SAVEPOINT brand');
    return { brandId: res.rows[0].id, name };
  } catch (err) {
    // Two companies racing for the same name: the unique index decides.
    if ((err as { code?: string }).code === '23505') {
      await tx.query('ROLLBACK TO SAVEPOINT brand');
      throw conflict('brand_name', 'That name is taken. Brand names are unique across the server.');
    }
    throw err;
  }
}

export interface DesignInput extends DesignChoice {
  brandId: string;
  priceCents: number;
}

/**
 * Saves a design as a new product: it passes the value check (price ≤ inputs × 1.8 + op, and within the
 * tier's price band) and luxury designs need a brand with enough reputation.
 */
export async function createDesign(tx: Tx, companyId: string, input: DesignInput) {
  const template = templateById(input.templateId);
  if (!template) throw badRequest('Unknown template.');
  if (!(input.tier in VARIANT_TIERS)) throw badRequest('Unknown variant tier.');
  for (const s of template.slots) {
    const i = input.slots[s.key] ?? 0;
    if (!Number.isInteger(i) || i < 0 || i >= s.options.length) throw badRequest(`Pick a ${s.label.toLowerCase()} option.`);
  }
  const slots = Object.fromEntries(template.slots.map((s) => [s.key, input.slots[s.key] ?? 0]));
  const choice: DesignChoice = { templateId: template.id, slots, tier: input.tier };

  const brand = (await tx.query<{ id: string; name: string; reputation: string }>(
    'SELECT id, name, reputation FROM brands WHERE id = $1 AND company_id = $2 FOR UPDATE',
    [input.brandId, companyId],
  )).rows[0];
  if (!brand) throw notFound('Brand');
  const tier = VARIANT_TIERS[input.tier];
  if (Number(brand.reputation) < tier.minReputation) {
    throw conflict('reputation', `${tier.label} designs need a brand with reputation ${tier.minReputation} or more.`);
  }
  const count = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM designs WHERE brand_id = $1', [brand.id])).rows[0].n;
  if (count >= BRAND_RULES.maxDesignsPerBrand) throw conflict('design_limit', `A brand can have at most ${BRAND_RULES.maxDesignsPerBrand} designs.`);

  const econ = designEconomics(choice);
  const maxCents = toCents(econ.maxPrice);
  if (!Number.isInteger(input.priceCents) || input.priceCents <= 0) throw badRequest('Set a wholesale price.');
  if (input.priceCents > maxCents) throw conflict('value_check', `Above the value cap. The most this design can sell for is ${econ.maxPrice} CR.`);

  const name = designName(brand.name, choice);
  const dupe = await tx.query('SELECT 1 FROM products WHERE lower(name) = lower($1)', [name]);
  const finalName = dupe.rowCount ? `${name} ${count + 1}` : name;
  const base = (await tx.query<{ tier: string }>('SELECT tier FROM products WHERE id = $1', [template.baseProductId])).rows[0];
  const productId = `d_${randomBytes(4).toString('hex')}`;
  await tx.query('INSERT INTO products (id, name, tier, ref_price_cents, npc_vendor) VALUES ($1, $2, $3, $4, false)', [productId, finalName, base.tier, input.priceCents]);
  await tx.query(
    `INSERT INTO designs (product_id, brand_id, template_id, building_type_id, base_product_id, tier, slots, materials_cents, art)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [productId, brand.id, template.id, template.buildingTypeId, template.baseProductId, input.tier, JSON.stringify(slots), toCents(econ.materials), designArt(choice)],
  );
  return { productId, name: finalName, priceCents: input.priceCents, maxPriceCents: maxCents };
}

export interface DesignRow {
  product_id: string;
  name: string;
  ref_price_cents: number;
  brand_id: string;
  brand_name: string;
  company_id: string;
  template_id: string;
  building_type_id: string;
  base_product_id: string;
  tier: VariantTier;
  slots: Record<string, number>;
  art: string;
}

const DESIGN_SELECT = `SELECT d.product_id, p.name, p.ref_price_cents, d.brand_id, br.name AS brand_name, br.company_id, d.template_id, d.building_type_id,
       d.base_product_id, d.tier, d.slots, d.art
  FROM designs d JOIN products p ON p.id = d.product_id JOIN brands br ON br.id = d.brand_id`;

const designView = (d: DesignRow) => ({
  id: d.product_id,
  name: d.name,
  priceCents: Number(d.ref_price_cents),
  brandId: d.brand_id,
  brandName: d.brand_name,
  companyId: d.company_id,
  templateId: d.template_id,
  buildingTypeId: d.building_type_id,
  baseProductId: d.base_product_id,
  tier: d.tier,
  slots: d.slots,
  art: d.art,
});

/** Every design on the server, so clients can name and draw any branded product they see. */
export async function allDesigns(q: Q) {
  const res = await q.query<DesignRow>(`${DESIGN_SELECT} ORDER BY d.created_at`);
  return res.rows.map(designView);
}

export async function designerView(db: Db, companyId: string) {
  const [brands, designs, stock, buildings] = await Promise.all([
    db.query<{ id: string; name: string; logo: number; reputation: string; created_at: Date }>(
      'SELECT id, name, logo, reputation, created_at FROM brands WHERE company_id = $1 ORDER BY created_at',
      [companyId],
    ),
    db.query<DesignRow>(`${DESIGN_SELECT} WHERE br.company_id = $1 ORDER BY d.created_at`, [companyId]),
    db.query<{ product_id: string; qty: number }>(
      `SELECT i.product_id, SUM(i.qty)::int AS qty FROM inventory i JOIN designs d ON d.product_id = i.product_id
       WHERE i.company_id = $1 GROUP BY i.product_id`,
      [companyId],
    ),
    db.query<{ id: string; name: string; building_type_id: string; design_id: string | null }>(
      'SELECT id, name, building_type_id, design_id FROM buildings WHERE company_id = $1 ORDER BY plot',
      [companyId],
    ),
  ]);
  const history = await db.query<{ brand_id: string; day: number; units: number; buyers: number; reputation: string }>(
    `SELECT brand_id, day, units, buyers, reputation FROM brand_days WHERE brand_id = ANY($1::uuid[]) ORDER BY day DESC`,
    [brands.rows.map((b) => b.id)],
  );
  return {
    rules: BRAND_RULES,
    brands: brands.rows.map((b) => {
      const days = history.rows.filter((h) => h.brand_id === b.id);
      return {
        id: b.id,
        name: b.name,
        logo: b.logo,
        reputation: Number(b.reputation),
        designs: designs.rows.filter((d) => d.brand_id === b.id).length,
        lastDay: days[0] ? { units: days[0].units, buyers: days[0].buyers } : null,
        idleDays: days.findIndex((d) => d.units > 0) === -1 ? days.length : days.findIndex((d) => d.units > 0),
      };
    }),
    designs: designs.rows.map((d) => ({
      ...designView(d),
      materials: pickedOptions(templateById(d.template_id)!, d.slots).map((o) => o.name),
      stock: stock.rows.find((s) => s.product_id === d.product_id)?.qty ?? 0,
      buildings: buildings.rows.filter((b) => b.design_id === d.product_id).map((b) => b.id),
    })),
    buildings: buildings.rows.map((b) => ({ id: b.id, name: b.name, typeId: b.building_type_id, designId: b.design_id })),
  };
}

/** Reputation price multiplier input: the brand reputation behind a product, or null for unbranded goods. */
export async function productReputation(q: Q, productId: string): Promise<number | null> {
  const res = await q.query<{ reputation: string }>('SELECT br.reputation FROM designs d JOIN brands br ON br.id = d.brand_id WHERE d.product_id = $1', [productId]);
  return res.rows[0] ? Number(res.rows[0].reputation) : null;
}

/**
 * Daily reputation update for a company's brands (part of the daily close): 1% decay, then growth from the
 * day's sales of the brand's designs (NPC shoppers and exchange buyers) and on-time contract deliveries.
 */
export async function updateReputation(tx: Tx, companyId: string, day: number) {
  const brands = await tx.query<{ id: string; reputation: string }>('SELECT id, reputation FROM brands WHERE company_id = $1 FOR UPDATE', [companyId]);
  const from = gameDayStart(day);
  const to = gameDayStart(day + 1);
  for (const b of brands.rows) {
    const npc = (await tx.query<{ units: number; qsum: number }>(
      `SELECT COALESCE(SUM(l.qty), 0)::int AS units, COALESCE(SUM(l.qty * l.quality), 0)::int AS qsum
       FROM npc_sale_log l JOIN designs d ON d.product_id = l.product_id
       WHERE l.company_id = $1 AND d.brand_id = $2 AND l.created_at >= $3 AND l.created_at < $4`,
      [companyId, b.id, from, to],
    )).rows[0];
    const exch = (await tx.query<{ units: number; qsum: number; buyers: number }>(
      `SELECT COALESCE(SUM(t.qty), 0)::int AS units, COALESCE(SUM(t.qty * t.quality), 0)::int AS qsum, count(DISTINCT t.buyer_id)::int AS buyers
       FROM trades t JOIN designs d ON d.product_id = t.product_id
       WHERE t.seller_id = $1 AND t.buyer_id <> $1 AND d.brand_id = $2 AND t.created_at >= $3 AND t.created_at < $4`,
      [companyId, b.id, from, to],
    )).rows[0];
    const onTime = (await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contract_deliveries cd JOIN contracts c ON c.id = cd.contract_id JOIN designs d ON d.product_id = c.product_id
       WHERE c.seller_id = $1 AND d.brand_id = $2 AND cd.status = 'settled' AND cd.late_hours = 0 AND cd.resolved_at >= $3 AND cd.resolved_at < $4`,
      [companyId, b.id, from, to],
    )).rows[0].n;
    const units = npc.units + exch.units;
    // NPC shoppers are anonymous: count one distinct buyer per 25 units, up to 10.
    const buyers = exch.buyers + Math.min(10, Math.ceil(npc.units / 25));
    const avgQuality = units ? (npc.qsum + exch.qsum) / units : 0;
    const rep = nextReputation(Number(b.reputation), { units, buyers, avgQuality, onTimeDeliveries: onTime });
    await tx.query('UPDATE brands SET reputation = $2 WHERE id = $1', [b.id, rep]);
    await tx.query(
      'INSERT INTO brand_days (brand_id, day, units, buyers, reputation) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (brand_id, day) DO NOTHING',
      [b.id, day, units, buyers, rep],
    );
  }
}
