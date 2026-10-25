import { NPC_BUYER_TIERS } from '../../shared/catalog';
import { npcPriceMultiplier } from '../../shared/economy';
import type { Tx } from './db';
import { badRequest, conflict } from './errors';
import { addGoods, takeGoods } from './inventory';
import { companyAccount, systemAccount, transfer } from './ledger';
import { loadProduct } from './catalog';
import { gameDay } from './time';
import { awardXp } from './xp';
import { XP_CAPS, XP_PER_CR_TRADE } from '../../shared/levels';
import { reputationPriceMultiplier } from '../../shared/designer';
import { productReputation } from './brands';

const MAX_NPC_QTY = 100_000;

/** NPC vendor sells raw inputs at reference price. Money leaves the economy (sink). */
export async function npcBuy(tx: Tx, companyId: string, productId: string, qty: number) {
  if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_NPC_QTY) throw badRequest('Quantity must be between 1 and 100,000.');
  const product = await loadProduct(tx, productId);
  if (!product.npcVendor) throw conflict('not_sold', `The NPC vendor does not sell ${product.name}.`);
  const cost = product.refPriceCents * qty;
  const cash = await companyAccount(tx, companyId, 'cash');
  const vendor = await systemAccount(tx, 'npc:vendor');
  await transfer(tx, 'npc_purchase', `NPC vendor: ${qty} ${product.name}`, cash, vendor, cost);
  await addGoods(tx, companyId, productId, 0, qty);
  return { productId, qty, costCents: cost };
}

/**
 * NPC buyers pay reference × quality multiplier × a volume factor that falls as the company
 * sells more of that product in the same game day (100% → 90% → 80% → 70%). This is the main faucet.
 */
export function npcSaleValue(unitCents: number, alreadySold: number, qty: number): number {
  let total = 0;
  let sold = alreadySold;
  let left = qty;
  for (const tier of NPC_BUYER_TIERS) {
    if (left === 0) break;
    const room = Math.max(0, tier.upTo - sold);
    const take = Math.min(left, room);
    total += take * unitCents * tier.factor;
    sold += take;
    left -= take;
  }
  return Math.round(total);
}

export async function npcSell(tx: Tx, companyId: string, productId: string, qty: number, quality: number) {
  if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_NPC_QTY) throw badRequest('Quantity must be between 1 and 100,000.');
  const product = await loadProduct(tx, productId);
  if (product.npcVendor) throw conflict('not_bought', `NPC buyers do not buy raw ${product.name}.`);
  await takeGoods(tx, companyId, productId, quality, qty);

  const day = gameDay();
  const prior = await tx.query<{ qty: number }>(
    `INSERT INTO npc_sales (company_id, product_id, day, qty) VALUES ($1, $2, $3, 0)
     ON CONFLICT (company_id, product_id, day) DO UPDATE SET qty = npc_sales.qty RETURNING qty`,
    [companyId, productId, day],
  );
  // Branded designs sell for up to 20% more, depending on the brand's reputation.
  const rep = await productReputation(tx, productId);
  const unit = product.refPriceCents * npcPriceMultiplier(quality) * (rep === null ? 1 : reputationPriceMultiplier(rep));
  const proceeds = npcSaleValue(unit, prior.rows[0].qty, qty);
  await tx.query('UPDATE npc_sales SET qty = qty + $4 WHERE company_id = $1 AND product_id = $2 AND day = $3', [companyId, productId, day, qty]);

  const cash = await companyAccount(tx, companyId, 'cash');
  const buyer = await systemAccount(tx, 'npc:buyer');
  await transfer(tx, 'npc_sale', `Sold ${qty} ${product.name} (Q${quality}) to NPC buyers`, buyer, cash, proceeds);
  await tx.query('INSERT INTO npc_sale_log (company_id, product_id, quality, qty, proceeds_cents) VALUES ($1, $2, $3, $4, $5)', [companyId, productId, quality, qty, proceeds]);
  await awardXp(tx, companyId, 'npc_sale', (proceeds / 100) * XP_PER_CR_TRADE, { note: `Sold ${qty} ${product.name} to NPCs`, capKey: 'market', dailyCap: XP_CAPS.market });
  return { productId, qty, quality, proceedsCents: proceeds };
}
