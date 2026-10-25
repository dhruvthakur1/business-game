/**
 * Regions (report section 2): every company builds in its home region. Each region has a production bonus and
 * a wage index. Wages are 40% of a building's op cost at index 1.0 (each level employs 10 workers), so the
 * index moves op cost between 0.92× (index 0.8) and 1.12× (index 1.3).
 */

export type RegionId = 'north' | 'east' | 'south' | 'west';

export interface RegionRule {
  id: RegionId;
  name: string;
  /** Wage index, 0.8–1.3. */
  wageIndex: number;
  /** Output multiplier per building type. */
  yieldBonus: Record<string, number>;
  bonusLabel: string;
  note: string;
}

export const REGION_RULES: Record<RegionId, RegionRule> = {
  north: {
    id: 'north', name: 'North', wageIndex: 1.0, yieldBonus: { farm: 1.1 },
    bonusLabel: '+10% farm yield', note: 'Best for a food start',
  },
  east: {
    id: 'east', name: 'East', wageIndex: 1.0, yieldBonus: { iron_mine: 1.1, power_plant: 1.1 },
    bonusLabel: '+10% mine and power plant output', note: 'Coal, iron, heavy industry',
  },
  south: {
    id: 'south', name: 'South', wageIndex: 0.8, yieldBonus: {},
    bonusLabel: 'Lowest wages (index 0.8)', note: 'Port hubs: cheaper freight once shipping arrives',
  },
  west: {
    id: 'west', name: 'West', wageIndex: 1.3, yieldBonus: { rnd_lab: 1.2, chip_fab: 1.1 },
    bonusLabel: '+20% research, +10% chip output', note: 'Tech & finance · wage index 1.3',
  },
};

export const WORKERS_PER_LEVEL = 10;
/** Share of a building's catalog op cost that is wages (at wage index 1.0). */
export const WAGE_SHARE = 0.4;

export const regionRule = (region: string): RegionRule => REGION_RULES[region as RegionId] ?? REGION_RULES.north;

/** Output multiplier for a building type in a region. */
export const yieldMultiplier = (region: string, buildingTypeId: string) => regionRule(region).yieldBonus[buildingTypeId] ?? 1;

/** Output units per cycle: base × level × regional yield, rounded down. */
export const cycleOutput = (baseQty: number, level: number, region: string, buildingTypeId: string) =>
  Math.floor(baseQty * level * yieldMultiplier(region, buildingTypeId));

/** Splits a cycle's op cost (already scaled by level and admin overhead) into wages and other operating costs. */
export function opCostSplit(opCost: number, region: string) {
  const other = opCost * (1 - WAGE_SHARE);
  const wages = opCost * WAGE_SHARE * regionRule(region).wageIndex;
  return { wages, other, total: wages + other };
}

// ---------- Freight (report section 2: transport) ----------

/**
 * Regions sit on a square: North–East–South–West–North are neighbours (1 hop); North–South and East–West are
 * across (2 hops). A delivery inside one region counts as a quarter hop.
 */
const NEIGHBOURS: Record<RegionId, RegionId[]> = { north: ['east', 'west'], east: ['north', 'south'], south: ['east', 'west'], west: ['north', 'south'] };

export function hops(from: string, to: string): number {
  if (from === to) return 0;
  return NEIGHBOURS[from as RegionId]?.includes(to as RegionId) ? 1 : 2;
}

export const FREIGHT = {
  /** CR per unit of weight per hop. */
  ratePerHop: 0.02,
  intraRegionHop: 0.25,
  /** Shipments to or from the South's port hubs cost this share of the normal rate. */
  southDiscount: 0.5,
  intraRegionHours: 1,
  hoursPerHop: 4,
} as const;

/** Freight in CR: units × unit weight × hops × 0.02 (intra-region = 0.25 hop), halved through the South. */
export function freightCost(units: number, unitWeight: number, from: string, to: string): number {
  const h = hops(from, to);
  const effective = h === 0 ? FREIGHT.intraRegionHop : h;
  const south = from === 'south' || to === 'south' ? FREIGHT.southDiscount : 1;
  return units * unitWeight * effective * FREIGHT.ratePerHop * south;
}

/** Game hours in transit: 1 inside a region, 4 per hop between regions. Weightless goods (power, research) are instant. */
export function transitHours(unitWeight: number, from: string, to: string): number {
  if (unitWeight <= 0) return 0;
  const h = hops(from, to);
  return h === 0 ? FREIGHT.intraRegionHours : h * FREIGHT.hoursPerHop;
}
