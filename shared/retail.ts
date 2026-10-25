/**
 * Retail (report section 2): the Supermarket sells food to NPC shoppers each cycle; the Luxury Store lists
 * T7 goods that other players buy with their personal wallets.
 */
import { npcPriceMultiplier, retailSpeedMultiplier } from './economy';

export const SUPERMARKET = {
  /** Units the shelf can sell per cycle, per building level. */
  unitsPerLevel: 60,
  /** Highest markup over the quality-adjusted reference price. */
  maxMarkup: 0.35,
  /** Products sold in supermarkets (designs whose base product is one of these count too). */
  goods: ['bread'] as string[],
} as const;

export const LUXURY_STORE = {
  /** Price band as a multiple of the product's reference (wholesale) price. */
  minMultiple: 1.2,
  maxMultiple: 3,
  /** Units that can be listed at once, per building level. */
  unitsPerLevel: 20,
  /** Store seller fee on each sale (a sink, like the exchange fee). */
  fee: 0.02,
  /** Products sold in luxury stores: T7 goods (designs based on them count too). */
  tier: 'T7',
} as const;

/**
 * Supermarket price band for one unit (cents): from the quality- and reputation-adjusted reference
 * up to 35% above it.
 */
export function supermarketBand(refCents: number, quality: number, reputationMult = 1) {
  const base = Math.round(refCents * npcPriceMultiplier(quality) * reputationMult);
  return { minCents: base, maxCents: Math.floor(base * (1 + SUPERMARKET.maxMarkup)) };
}

/**
 * Units sold in one cycle: shoppers buy fewer as the markup rises (1 − markup) and more with quality
 * (1 + 0.1 × Q), never more than the shelf capacity or the stock.
 */
export function supermarketUnits(capacity: number, stocked: number, priceCents: number, baseCents: number, quality: number): number {
  const markup = Math.max(0, Math.min(SUPERMARKET.maxMarkup, priceCents / baseCents - 1));
  const demand = Math.min(1, (1 - markup) * retailSpeedMultiplier(quality));
  return Math.min(stocked, Math.floor(capacity * demand));
}

/** The markup that sells a full shelf at this quality (the revenue-maximizing price). */
export function bestSupermarketMarkup(quality: number): number {
  return Math.min(SUPERMARKET.maxMarkup, Math.max(0, 1 - 1 / retailSpeedMultiplier(quality)));
}

export function luxuryBand(refCents: number) {
  return { minCents: Math.ceil(refCents * LUXURY_STORE.minMultiple), maxCents: Math.floor(refCents * LUXURY_STORE.maxMultiple) };
}

/** Personal items bought from player stores are keyed by product, not by catalog item. */
export const STORE_ITEM_PREFIX = 'product:';
