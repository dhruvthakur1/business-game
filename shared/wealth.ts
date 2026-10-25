/**
 * Personal wealth (report section 5): the owner's wallet is kept apart from the company. Money reaches it as
 * salary, dividends or owner withdrawals, all taxed on rolling 30-day inflows, and is spent on luxury goods
 * that build prestige.
 */
import { itemPrestige, type Rarity } from './economy';

export type ItemCategory = 'car' | 'watch' | 'clothing' | 'home' | 'toy';

/** Daily upkeep (share of price) and the NPC buyback rate for each category. */
export const CATEGORY_RULES: Record<ItemCategory, { upkeepPerDay: number; buyback: number }> = {
  car: { upkeepPerDay: 0.0002, buyback: 0.7 },
  watch: { upkeepPerDay: 0, buyback: 0.7 },
  clothing: { upkeepPerDay: 0, buyback: 0.5 },
  home: { upkeepPerDay: 0.0003, buyback: 0.75 },
  toy: { upkeepPerDay: 0.0008, buyback: 0.7 },
};

export interface LuxuryItem {
  id: string;
  name: string;
  category: ItemCategory;
  /** CR. 0 = free starter rung (always owned); null = auction only (not sold by the NPC shop). */
  price: number | null;
  rarity: Rarity;
  art?: string;
}

export interface Ladder {
  id: string;
  label: string;
  rule: string;
  items: LuxuryItem[];
}

const P = (file: string) => `/art/products/${file}.svg`;

export const LADDERS: Ladder[] = [
  {
    id: 'garage', label: 'Garage',
    rule: 'Cars: upkeep 0.02% of price per day · NPC buys back at 70%',
    items: [
      { id: 'car_economy', name: 'Economy hatch', category: 'car', price: 2500, rarity: 'common', art: P('car-economy') },
      { id: 'car_sports', name: 'Sports coupé', category: 'car', price: 90_000, rarity: 'common', art: P('car-sports') },
      { id: 'car_sedan', name: 'Luxury sedan', category: 'car', price: 400_000, rarity: 'common', art: P('car-sedan') },
      { id: 'car_supercar', name: 'Supercar', category: 'car', price: 2_500_000, rarity: 'limited', art: P('car-supercar') },
      { id: 'car_hypercar', name: 'Hypercar', category: 'car', price: 15_000_000, rarity: 'limited', art: P('car-hypercar') },
    ],
  },
  {
    id: 'vault', label: 'Vault',
    rule: 'Watches: no upkeep · NPC buys back at 70% · Founders editions are 1-of-100 and sold only at auction',
    items: [
      { id: 'watch_quartz', name: 'Steel quartz', category: 'watch', price: 1500, rarity: 'common', art: P('watch-quartz') },
      { id: 'watch_automatic', name: 'Automatic', category: 'watch', price: 12_000, rarity: 'common', art: P('watch-automatic') },
      { id: 'watch_gold', name: 'Gold dress watch', category: 'watch', price: 150_000, rarity: 'common', art: P('watch-gold-dress') },
      { id: 'watch_complication', name: 'Complication', category: 'watch', price: 1_000_000, rarity: 'limited', art: P('watch-tourbillon') },
      { id: 'watch_founders', name: 'Founders 1-of-100', category: 'watch', price: null, rarity: 'unique', art: P('watch-founders') },
    ],
  },
  {
    id: 'wardrobe', label: 'Wardrobe',
    rule: 'Clothing: no upkeep · NPC buys back at 50% · worn on your avatar and profile',
    items: [
      { id: 'wear_streetwear', name: 'Streetwear', category: 'clothing', price: 300, rarity: 'common', art: P('streetwear-tee') },
      { id: 'wear_sneakers', name: 'Designer sneakers', category: 'clothing', price: 5000, rarity: 'common', art: P('sneakers') },
      { id: 'wear_bag', name: 'Designer bag', category: 'clothing', price: 25_000, rarity: 'common', art: P('handbag') },
      { id: 'wear_gown', name: 'Gala gown', category: 'clothing', price: 250_000, rarity: 'limited', art: P('gala-gown') },
      { id: 'wear_collab', name: 'Numbered collab drop', category: 'clothing', price: null, rarity: 'unique', art: P('sneakers') },
    ],
  },
  {
    id: 'homes', label: 'Homes & toys',
    rule: 'Homes: upkeep 0.03%/day, NPC buyback 75% · Yachts and jets: upkeep 0.08%/day, buyback 70%',
    items: [
      { id: 'home_studio', name: 'Starter studio', category: 'home', price: 0, rarity: 'common' },
      { id: 'home_apartment', name: 'Apartment', category: 'home', price: 500_000, rarity: 'common' },
      { id: 'home_villa', name: 'Villa', category: 'home', price: 5_000_000, rarity: 'limited' },
      { id: 'toy_yacht', name: 'Superyacht', category: 'toy', price: 150_000_000, rarity: 'limited', art: P('superyacht') },
      { id: 'toy_jet', name: 'Private jet', category: 'toy', price: 300_000_000, rarity: 'limited', art: P('private-jet') },
    ],
  },
];

export const ALL_ITEMS = LADDERS.flatMap((l) => l.items.map((item, rung) => ({ ...item, ladderId: l.id, rung })));
export const itemById = (id: string) => ALL_ITEMS.find((i) => i.id === id);

/** CR per day of upkeep for one owned item. */
export const itemUpkeep = (item: LuxuryItem) => (item.price ?? 0) * CATEGORY_RULES[item.category].upkeepPerDay;
export const itemBuyback = (item: LuxuryItem) => (item.price ?? 0) * CATEGORY_RULES[item.category].buyback;

export const PRESTIGE_PER_TROPHY = 100;

/** Prestige = Σ item prestige (log-scaled by price × rarity) for displayed items + 100 per trophy. */
export function prestigeScore(items: LuxuryItem[], trophies: number): number {
  return Math.round(items.reduce((s, i) => s + (i.price ? itemPrestige(i.price, i.rarity) : 0), 0) + PRESTIGE_PER_TROPHY * trophies);
}

export const PAY_RULES = {
  /** Salary cap: share of the 7-day average daily operating profit. */
  salaryShare: 0.15,
  /** Extra tax on owner withdrawals, on top of income tax. */
  withdrawalTax: 0.1,
  /** Days of upkeep and debt service the company must keep in cash after any payout. */
  reserveDays: 7,
  /** Window for income tax bands and dividend headroom. */
  windowDays: 30,
} as const;

/** Tax-free allowance: the first income-tax band ceiling. */
export const TAX_FREE_ALLOWANCE = 50_000;
