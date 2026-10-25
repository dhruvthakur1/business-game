import { adminOverhead } from '../../shared/economy';
import { XP_CAPS, XP_PER_CR_TRADE } from '../../shared/levels';
import { reputationPriceMultiplier } from '../../shared/designer';
import { LUXURY_STORE, luxuryBand, STORE_ITEM_PREFIX, SUPERMARKET, supermarketBand, supermarketUnits } from '../../shared/retail';
import { gameMinutesToMs } from './config';
import type { Db, Tx } from './db';
import { badRequest, conflict, notFound } from './errors';
import { addGoods, takeGoods } from './inventory';
import { companyAccount, post, systemAccount, transfer } from './ledger';
import { loadBuildingType, loadProduct, type BuildingTypeRow } from './catalog';
import { productReputation } from './brands';
import { awardXp } from './xp';

type Q = Pick<Tx, 'query'>;

interface BuildingRow {
  id: string;
  building_type_id: string;
  level: number;
  name: string;
  shelf_product_id: string | null;
  shelf_quality: number | null;
  shelf_price_cents: number | null;
}

async function ownBuilding(q: Q, companyId: string, buildingId: string, typeId: string, lock = false): Promise<BuildingRow> {
  const res = await q.query<BuildingRow>(
    `SELECT id, building_type_id, level, name, shelf_product_id, shelf_quality, shelf_price_cents
     FROM buildings WHERE id = $1 AND company_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [buildingId, companyId],
  );
  const b = res.rows[0];
  if (!b) throw notFound('Building');
  if (b.building_type_id !== typeId) throw conflict('wrong_building', typeId === 'supermarket' ? 'Only supermarkets have shelves.' : 'Only luxury stores have listings.');
  return b;
}

/** The product a good counts as for retail rules: itself, or a design's base product. */
async function baseOf(q: Q, productId: string): Promise<{ base: string; tier: string; design: { tier: string } | null }> {
  const res = await q.query<{ tier: string; base_product_id: string | null; design_tier: string | null }>(
    'SELECT p.tier, d.base_product_id, d.tier AS design_tier FROM products p LEFT JOIN designs d ON d.product_id = p.id WHERE p.id = $1',
    [productId],
  );
  const r = res.rows[0];
  if (!r) throw badRequest(`Unknown product ${productId}`);
  return { base: r.base_product_id ?? productId, tier: r.tier, design: r.design_tier ? { tier: r.design_tier } : null };
}

/** Shelf price band for a product at a quality (cents), including the brand's reputation for designs. */
async function shelfBand(q: Q, productId: string, quality: number) {
  const product = await loadProduct(q, productId);
  const rep = await productReputation(q, productId);
  return supermarketBand(product.refPriceCents, quality, rep === null ? 1 : reputationPriceMultiplier(rep));
}

// ---------- Supermarket ----------

export async function setShelf(tx: Tx, companyId: string, buildingId: string, input: { productId: string; quality: number; priceCents: number }) {
  const b = await ownBuilding(tx, companyId, buildingId, 'supermarket', true);
  const { base } = await baseOf(tx, input.productId);
  if (!SUPERMARKET.goods.includes(base)) throw conflict('not_food', 'Supermarkets sell food: bread and bread designs.');
  if (!Number.isInteger(input.quality) || input.quality < 0 || input.quality > 5) throw badRequest('Quality must be 0–5.');
  const band = await shelfBand(tx, input.productId, input.quality);
  if (input.priceCents < band.minCents || input.priceCents > band.maxCents) {
    throw conflict('price_band', `Shelf price must be between ${(band.minCents / 100).toFixed(2)} and ${(band.maxCents / 100).toFixed(2)} CR.`);
  }
  await tx.query('UPDATE buildings SET shelf_product_id = $2, shelf_quality = $3, shelf_price_cents = $4 WHERE id = $1', [b.id, input.productId, input.quality, input.priceCents]);
  return { buildingId: b.id, ...input, band };
}

/**
 * Starts a supermarket cycle: stocks the shelf from the warehouse (up to 60 × level units of the shelf
 * product at the shelf quality), charges the op cost, and settles sales at collect.
 */
export async function startShelfJob(tx: Tx, companyId: string, buildingId: string, type: BuildingTypeRow) {
  const b = await ownBuilding(tx, companyId, buildingId, 'supermarket');
  if (!b.shelf_product_id || b.shelf_quality === null || !b.shelf_price_cents) throw conflict('no_shelf', `Set what ${b.name} sells first.`);
  const capacity = SUPERMARKET.unitsPerLevel * b.level;
  const have = (await tx.query<{ qty: number }>(
    'SELECT qty FROM inventory WHERE company_id = $1 AND product_id = $2 AND quality = $3',
    [companyId, b.shelf_product_id, b.shelf_quality],
  )).rows[0]?.qty ?? 0;
  const stock = Math.min(capacity, have);
  const product = await loadProduct(tx, b.shelf_product_id);
  if (stock <= 0) throw conflict('missing_inputs', `No ${product.name.toLowerCase()} at Q${b.shelf_quality} in the warehouse to stock the shelf.`);
  await takeGoods(tx, companyId, b.shelf_product_id, b.shelf_quality, stock);

  // Reference prices move; keep the standing price inside today's band.
  const band = await shelfBand(tx, b.shelf_product_id, b.shelf_quality);
  const price = Math.max(band.minCents, Math.min(band.maxCents, Number(b.shelf_price_cents)));

  const levels = await tx.query<{ total: number }>('SELECT COALESCE(SUM(level), 0)::int AS total FROM buildings WHERE company_id = $1', [companyId]);
  const opCost = Math.round(type.opCostCents * b.level * adminOverhead(levels.rows[0].total));
  await transfer(tx, 'op_cost', `${b.name}: operating cost`, await companyAccount(tx, companyId, 'cash'), await systemAccount(tx, 'sink:operations'), opCost);

  const now = new Date();
  const finishes = new Date(now.getTime() + gameMinutesToMs(type.cycleMinutes));
  const job = await tx.query<{ id: string }>(
    `INSERT INTO production_jobs (building_id, started_at, finishes_at, state, output_product, output_qty, output_quality, input_quality, input_value_cents, retail_price_cents)
     VALUES ($1, $2, $3, 'running', $4, $5, $6, $6, 0, $7) RETURNING id`,
    [b.id, now, finishes, b.shelf_product_id, stock, b.shelf_quality, price],
  );
  return { jobId: job.rows[0].id, finishesAt: finishes.toISOString(), outputQuality: b.shelf_quality, opCostCents: opCost, stocked: stock, priceCents: price };
}

export interface ShelfJobRow {
  id: string;
  building_id: string;
  output_product: string;
  output_qty: number;
  output_quality: number;
  retail_price_cents: number;
}

/** Settles a finished supermarket cycle: shoppers pay for what sold (faucet), the rest goes back to the warehouse. */
export async function settleShelfJob(tx: Tx, companyId: string, row: ShelfJobRow) {
  const level = (await tx.query<{ level: number }>('SELECT level FROM buildings WHERE id = $1', [row.building_id])).rows[0]?.level ?? 1;
  const band = await shelfBand(tx, row.output_product, row.output_quality);
  const price = Number(row.retail_price_cents);
  const sold = supermarketUnits(SUPERMARKET.unitsPerLevel * level, row.output_qty, price, band.minCents, row.output_quality);
  const proceeds = sold * price;
  const product = await loadProduct(tx, row.output_product);
  if (proceeds > 0) {
    await transfer(tx, 'npc_sale', `Supermarket: ${sold} ${product.name} (Q${row.output_quality}) to shoppers`, await systemAccount(tx, 'npc:buyer'), await companyAccount(tx, companyId, 'cash'), proceeds);
    await tx.query('INSERT INTO npc_sale_log (company_id, product_id, quality, qty, proceeds_cents) VALUES ($1, $2, $3, $4, $5)', [companyId, row.output_product, row.output_quality, sold, proceeds]);
  }
  await addGoods(tx, companyId, row.output_product, row.output_quality, row.output_qty - sold);
  // Value added by retail: the markup over the product's base price.
  const valueAdd = proceeds - sold * product.basePriceCents;
  await tx.query('UPDATE production_jobs SET sold_qty = $2, proceeds_cents = $3, value_add_cents = $4 WHERE id = $1', [row.id, sold, proceeds, valueAdd]);
  const xp = await awardXp(tx, companyId, 'npc_sale', (proceeds / 100) * XP_PER_CR_TRADE, { note: `Supermarket sold ${sold} ${product.name}`, capKey: 'market', dailyCap: XP_CAPS.market });
  return { sold, unsold: row.output_qty - sold, proceedsCents: proceeds, xp: xp.awarded };
}

// ---------- Luxury Store ----------

async function listedUnits(q: Q, buildingId: string): Promise<number> {
  return (await q.query<{ n: number }>('SELECT COALESCE(SUM(qty), 0)::int AS n FROM store_listings WHERE building_id = $1', [buildingId])).rows[0].n;
}

export async function createListing(tx: Tx, companyId: string, buildingId: string, input: { productId: string; quality: number; qty: number; priceCents: number }) {
  const b = await ownBuilding(tx, companyId, buildingId, 'luxury_store', true);
  const { tier } = await baseOf(tx, input.productId);
  if (tier !== LUXURY_STORE.tier) throw conflict('not_luxury', 'Luxury stores sell T7 goods only.');
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw badRequest('List at least one unit.');
  const capacity = LUXURY_STORE.unitsPerLevel * b.level;
  if ((await listedUnits(tx, b.id)) + input.qty > capacity) throw conflict('store_full', `${b.name} can list ${capacity} units at once.`);
  const product = await loadProduct(tx, input.productId);
  const band = luxuryBand(product.refPriceCents);
  if (input.priceCents < band.minCents || input.priceCents > band.maxCents) {
    throw conflict('price_band', `Luxury prices must be 1.2×–3× wholesale: ${(band.minCents / 100).toFixed(2)} to ${(band.maxCents / 100).toFixed(2)} CR.`);
  }
  await takeGoods(tx, companyId, input.productId, input.quality, input.qty);
  const res = await tx.query<{ id: string }>(
    'INSERT INTO store_listings (building_id, company_id, product_id, quality, qty, price_cents) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [b.id, companyId, input.productId, input.quality, input.qty, input.priceCents],
  );
  return { listingId: res.rows[0].id };
}

export async function withdrawListing(tx: Tx, companyId: string, listingId: string) {
  const l = (await tx.query<{ product_id: string; quality: number; qty: number }>(
    'DELETE FROM store_listings WHERE id = $1 AND company_id = $2 RETURNING product_id, quality, qty',
    [listingId, companyId],
  )).rows[0];
  if (!l) throw notFound('Listing');
  await addGoods(tx, companyId, l.product_id, l.quality, l.qty);
  return { returnedQty: l.qty };
}

/**
 * A player buys one unit from another company's luxury store with their personal wallet. The piece joins their
 * collection (one of each product); the store's company gets the price minus a 2% fee.
 */
export async function buyFromStore(tx: Tx, buyerId: string, listingId: string) {
  const l = (await tx.query<{ id: string; company_id: string; product_id: string; quality: number; qty: number; price_cents: number }>(
    'SELECT id, company_id, product_id, quality, qty, price_cents FROM store_listings WHERE id = $1 FOR UPDATE',
    [listingId],
  )).rows[0];
  if (!l || l.qty <= 0) throw notFound('Listing');
  if (l.company_id === buyerId) throw conflict('own_store', 'You can’t buy from your own store.');
  const itemId = `${STORE_ITEM_PREFIX}${l.product_id}`;
  const owned = await tx.query('SELECT 1 FROM personal_items WHERE company_id = $1 AND item_id = $2', [buyerId, itemId]);
  if (owned.rowCount) throw conflict('owned', 'You already own one of these.');

  const price = Number(l.price_cents);
  const fee = Math.round(price * LUXURY_STORE.fee);
  const product = await loadProduct(tx, l.product_id);
  await post(tx, {
    kind: 'store_sale',
    memo: `Luxury store: ${product.name} (Q${l.quality})`,
    entries: [
      { accountId: await companyAccount(tx, buyerId, 'wallet'), amount: -price },
      { accountId: await companyAccount(tx, l.company_id, 'cash'), amount: price - fee },
      { accountId: await systemAccount(tx, 'sink:store_fees'), amount: fee },
    ],
  });
  await tx.query('UPDATE store_listings SET qty = qty - 1 WHERE id = $1', [l.id]);
  const { design } = await baseOf(tx, l.product_id);
  const rarity = design?.tier === 'luxury' ? 'limited' : 'common';
  await tx.query(
    'INSERT INTO personal_items (company_id, item_id, price_cents, quality, rarity) VALUES ($1, $2, $3, $4, $5)',
    [buyerId, itemId, price, l.quality, rarity],
  );
  await tx.query(
    'INSERT INTO store_sales (listing_id, seller_id, buyer_id, product_id, quality, price_cents, fee_cents) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [l.id, l.company_id, buyerId, l.product_id, l.quality, price, fee],
  );
  await awardXp(tx, l.company_id, 'npc_sale', ((price - fee) / 100) * XP_PER_CR_TRADE, { note: `Luxury store sold ${product.name}`, capKey: 'market', dailyCap: XP_CAPS.market });
  return { itemId, priceCents: price };
}

/** Every open luxury listing on the server, cheapest first. */
export async function storeListings(db: Db, companyId: string) {
  const res = await db.query<{ id: string; company_id: string; seller: string; store: string; product_id: string; quality: number; qty: number; price_cents: number }>(
    `SELECT l.id, l.company_id, c.name AS seller, b.name AS store, l.product_id, l.quality, l.qty, l.price_cents
     FROM store_listings l JOIN companies c ON c.id = l.company_id JOIN buildings b ON b.id = l.building_id
     WHERE l.qty > 0 ORDER BY l.price_cents, l.created_at LIMIT 100`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    sellerName: r.seller,
    storeName: r.store,
    mine: r.company_id === companyId,
    productId: r.product_id,
    quality: r.quality,
    qty: r.qty,
    priceCents: Number(r.price_cents),
  }));
}

/** Retail panel for a supermarket or luxury store building page. */
export async function retailView(db: Db, companyId: string, buildingId: string) {
  const b = (await db.query<BuildingRow>(
    'SELECT id, building_type_id, level, name, shelf_product_id, shelf_quality, shelf_price_cents FROM buildings WHERE id = $1 AND company_id = $2',
    [buildingId, companyId],
  )).rows[0];
  if (!b) throw notFound('Building');
  const type = await loadBuildingType(db, b.building_type_id);

  if (b.building_type_id === 'supermarket') {
    const lots = await db.query<{ product_id: string; quality: number; qty: number }>(
      `SELECT i.product_id, i.quality, i.qty FROM inventory i LEFT JOIN designs d ON d.product_id = i.product_id
       WHERE i.company_id = $1 AND i.qty > 0 AND COALESCE(d.base_product_id, i.product_id) = ANY($2) ORDER BY i.product_id, i.quality`,
      [companyId, SUPERMARKET.goods],
    );
    const bands = await Promise.all(lots.rows.map((l) => shelfBand(db, l.product_id, l.quality)));
    const cycles = await db.query<{ output_product: string; output_qty: number; sold_qty: number; proceeds_cents: number; retail_price_cents: number; collected_at: Date }>(
      `SELECT output_product, output_qty, sold_qty, proceeds_cents, retail_price_cents, collected_at FROM production_jobs
       WHERE building_id = $1 AND state = 'collected' AND retail_price_cents IS NOT NULL ORDER BY collected_at DESC LIMIT 5`,
      [b.id],
    );
    const shelfBandNow = b.shelf_product_id && b.shelf_quality !== null ? await shelfBand(db, b.shelf_product_id, b.shelf_quality) : null;
    return {
      kind: 'supermarket' as const,
      capacity: SUPERMARKET.unitsPerLevel * b.level,
      opCostCents: type.opCostCents * b.level,
      shelf: b.shelf_product_id ? { productId: b.shelf_product_id, quality: b.shelf_quality!, priceCents: Number(b.shelf_price_cents), band: shelfBandNow! } : null,
      lots: lots.rows.map((l, i) => ({ productId: l.product_id, quality: l.quality, qty: l.qty, band: bands[i] })),
      recent: cycles.rows.map((c) => ({
        productId: c.output_product, stocked: c.output_qty, sold: c.sold_qty, proceedsCents: Number(c.proceeds_cents), priceCents: Number(c.retail_price_cents), at: c.collected_at.toISOString(),
      })),
    };
  }
  if (b.building_type_id === 'luxury_store') {
    const [listings, lots, sales] = await Promise.all([
      db.query<{ id: string; product_id: string; quality: number; qty: number; price_cents: number }>(
        'SELECT id, product_id, quality, qty, price_cents FROM store_listings WHERE building_id = $1 ORDER BY created_at',
        [b.id],
      ),
      db.query<{ product_id: string; quality: number; qty: number; ref: number }>(
        `SELECT i.product_id, i.quality, i.qty, COALESCE(r.price_cents, p.ref_price_cents) AS ref
         FROM inventory i JOIN products p ON p.id = i.product_id LEFT JOIN reference_prices r ON r.product_id = p.id
         WHERE i.company_id = $1 AND i.qty > 0 AND p.tier = $2 ORDER BY i.product_id, i.quality`,
        [companyId, LUXURY_STORE.tier],
      ),
      db.query<{ product_id: string; buyer: string; price_cents: number; created_at: Date }>(
        `SELECT s.product_id, c.name AS buyer, s.price_cents, s.created_at FROM store_sales s JOIN companies c ON c.id = s.buyer_id
         WHERE s.seller_id = $1 ORDER BY s.id DESC LIMIT 5`,
        [companyId],
      ),
    ]);
    return {
      kind: 'luxury_store' as const,
      capacity: LUXURY_STORE.unitsPerLevel * b.level,
      listed: listings.rows.reduce((s, l) => s + l.qty, 0),
      listings: listings.rows.map((l) => ({ id: l.id, productId: l.product_id, quality: l.quality, qty: l.qty, priceCents: Number(l.price_cents) })),
      lots: lots.rows.map((l) => ({ productId: l.product_id, quality: l.quality, qty: l.qty, band: luxuryBand(Number(l.ref)) })),
      recent: sales.rows.map((s) => ({ productId: s.product_id, buyerName: s.buyer, priceCents: Number(s.price_cents), at: s.created_at.toISOString() })),
    };
  }
  throw conflict('not_retail', `${b.name} is not a retail building.`);
}
