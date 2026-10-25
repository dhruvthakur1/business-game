/** Research (report section 1): eight families, points from R&D labs, five quality tiers each. */

export const RESEARCH_THRESHOLDS = [50, 250, 1500, 6000, 20000] as const;

export type FamilyId = 'agri' | 'food' | 'textiles' | 'metals' | 'electronics' | 'auto' | 'luxury' | 'energy';

export interface FamilyDef {
  id: FamilyId;
  name: string;
  /** Planned recipe unlocks per tier. Most of these products are not in the game yet. */
  planned: [string, string, string, string, string];
}

export const FAMILIES: FamilyDef[] = [
  { id: 'agri', name: 'Agri', planned: ['Fertilizer mix', 'Cotton & coffee seeds', 'Greenhouses', 'Precision farming', 'Heirloom crops'] },
  { id: 'food', name: 'Food', planned: ['Pastries', 'Cheese', 'Packaged meals', 'Chocolate', 'Haute cuisine'] },
  { id: 'textiles', name: 'Textiles', planned: ['Fine fabric', 'Denim & jeans', 'Dyes & prints', 'Silk weaving', 'Couture'] },
  { id: 'metals', name: 'Metals', planned: ['Alloy steel', 'Aluminium', 'Copper wire', 'Precision casting', 'Aerospace alloys'] },
  { id: 'electronics', name: 'Electronics', planned: ['Circuit boards', 'Display panels', 'Phone batteries', 'Advanced chips', 'Server racks'] },
  { id: 'auto', name: 'Auto', planned: ['Tires', 'Engines', 'EV battery packs', 'SUVs', 'Sports cars'] },
  { id: 'luxury', name: 'Luxury', planned: ['Cut gems', 'Watch movement parts', 'Haute-couture line', 'Diamond rings', 'Hypercar trim'] },
  { id: 'energy', name: 'Energy', planned: ['Grid storage', 'Solar panels', 'Efficient turbines', 'Wind farms', 'Smart grid'] },
];

/** Which family's research improves each building's output. Retail and labs have none. */
export const BUILDING_FAMILY: Record<string, FamilyId | undefined> = {
  farm: 'agri',
  cotton_farm: 'agri',
  mill: 'food',
  bakery: 'food',
  iron_mine: 'metals',
  steel_mill: 'metals',
  quarry: 'metals',
  sand_pit: 'metals',
  cement_plant: 'metals',
  coal_mine: 'energy',
  textile_mill: 'textiles',
  power_plant: 'energy',
  solar: 'energy',
  chip_fab: 'electronics',
  car_factory: 'auto',
  watchmaker: 'luxury',
  garment_factory: 'textiles',
};

export const RESEARCH_PRODUCT = 'research_points';

/** Highest quality tier reached with this many points (0–5). */
export function researchTier(points: number): number {
  return RESEARCH_THRESHOLDS.filter((t) => points >= t).length;
}

/**
 * The report's research bonus: production may step one quality above its inputs' average, but only while the
 * family's research tier is higher than that average. Without research, output keeps its inputs' quality.
 */
export function researchBonus(tier: number, meanInputQuality: number): 0 | 1 {
  return tier > Math.floor(meanInputQuality) ? 1 : 0;
}

/** Points still needed for the next tier, or null at Q5. */
export function nextThreshold(points: number): number | null {
  return RESEARCH_THRESHOLDS.find((t) => points < t) ?? null;
}
