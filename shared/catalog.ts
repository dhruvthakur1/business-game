/**
 * Game catalog shared by server (seed + rules) and web (display).
 * Values come from sections 2–3 of the business-logic report. Prices are in CR.
 */

export type TierCode = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7';
export type SectorTag = TierCode | 'Energy' | 'Retail' | 'Research';

export interface ProductDef {
  id: string;
  name: string;
  tier: TierCode;
  refPrice: number;
  unit?: string;
  /** Sold by the NPC vendor at reference price (raw inputs). */
  npcVendor?: boolean;
}

export interface RecipeLine {
  productId: string;
  qty: number;
}

export interface BuildingTypeDef {
  id: string;
  name: string;
  tag: SectorTag;
  buildCost: number;
  unlockLevel: number;
  cycleHours: number;
  inputs: RecipeLine[];
  outputs: RecipeLine[];
  opCost: number;
  upkeepPerDay: number;
  summary?: string;
  netLabel: string;
}

export const PRODUCT_DEFS: ProductDef[] = [
  { id: 'seeds', name: 'Seeds', tier: 'T0', refPrice: 1.2, npcVendor: true },
  { id: 'fertilizer', name: 'Fertilizer', tier: 'T0', refPrice: 4, npcVendor: true },
  { id: 'water', name: 'Water', tier: 'T0', refPrice: 0.3, npcVendor: true },
  { id: 'iron_ore', name: 'Iron ore', tier: 'T0', refPrice: 6 },
  { id: 'coal', name: 'Coal', tier: 'T0', refPrice: 3, npcVendor: true },
  { id: 'sand', name: 'Sand', tier: 'T0', refPrice: 1.5, npcVendor: true },
  { id: 'wheat', name: 'Wheat', tier: 'T1', refPrice: 4.5 },
  { id: 'cotton', name: 'Cotton', tier: 'T1', refPrice: 5.5 },
  { id: 'flour', name: 'Flour', tier: 'T2', refPrice: 8 },
  { id: 'fabric', name: 'Fabric', tier: 'T2', refPrice: 15 },
  { id: 'steel', name: 'Steel', tier: 'T2', refPrice: 24 },
  { id: 'mwh', name: 'Electricity', tier: 'T2', refPrice: 40, unit: 'MWh' },
  { id: 'silicon_wafer', name: 'Silicon wafer', tier: 'T2', refPrice: 25 },
  { id: 'gold_bar', name: 'Gold bar', tier: 'T2', refPrice: 950 },
  { id: 'glass', name: 'Glass', tier: 'T2', refPrice: 12 },
  { id: 'chip', name: 'Chip', tier: 'T3', refPrice: 52 },
  { id: 'engine', name: 'Engine', tier: 'T3', refPrice: 520 },
  { id: 'auto_parts', name: 'Auto parts kit', tier: 'T3', refPrice: 190 },
  { id: 'movement_parts', name: 'Watch movement parts', tier: 'T3', refPrice: 30 },
  { id: 'sapphire', name: 'Sapphire crystal', tier: 'T3', refPrice: 20 },
  { id: 'bread', name: 'Bread', tier: 'T4', refPrice: 27 },
  { id: 'smartphone', name: 'Smartphone', tier: 'T4', refPrice: 230 },
  { id: 'laptop', name: 'Laptop', tier: 'T4', refPrice: 650 },
  { id: 'economy_car', name: 'Economy car', tier: 'T4', refPrice: 1450 },
  { id: 'suv', name: 'SUV', tier: 'T4', refPrice: 2600 },
  { id: 'sports_car', name: 'Sports car', tier: 'T4', refPrice: 9000 },
  { id: 'luxury_watch', name: 'Luxury watch', tier: 'T7', refPrice: 900 },
  { id: 'research_points', name: 'Research points', tier: 'T5', refPrice: 12, unit: 'RP' },
];

const r = (productId: string, qty: number): RecipeLine => ({ productId, qty });

/** Level-1 values per cycle. */
export const BUILDING_TYPE_DEFS: BuildingTypeDef[] = [
  { id: 'farm', name: 'Grain Farm', tag: 'T1', buildCost: 30_000, unlockLevel: 1, cycleHours: 4,
    inputs: [r('seeds', 60), r('fertilizer', 20)], outputs: [r('wheat', 100)], opCost: 120, upkeepPerDay: 100, netLabel: '+914' },
  { id: 'mill', name: 'Flour Mill', tag: 'T2', buildCost: 40_000, unlockLevel: 1, cycleHours: 4,
    inputs: [r('wheat', 100)], outputs: [r('flour', 80)], opCost: 70, upkeepPerDay: 100, netLabel: '+543' },
  { id: 'bakery', name: 'Bakery', tag: 'T4', buildCost: 40_000, unlockLevel: 1, cycleHours: 4,
    inputs: [r('flour', 80)], outputs: [r('bread', 40)], opCost: 120, upkeepPerDay: 100, netLabel: '+1,690' },
  { id: 'supermarket', name: 'Supermarket', tag: 'Retail', buildCost: 50_000, unlockLevel: 3, cycleHours: 4,
    inputs: [], outputs: [], opCost: 150, upkeepPerDay: 120, summary: 'Sells food to NPC shoppers at up to 1.35× ref · 60 units/cycle', netLabel: '+1.0–1.8k' },
  { id: 'rnd_lab', name: 'R&D Lab', tag: 'Research', buildCost: 80_000, unlockLevel: 3, cycleHours: 4,
    inputs: [r('mwh', 2)], outputs: [r('research_points', 25)], opCost: 90, upkeepPerDay: 150,
    summary: '2 MWh → 25 research points · 4 h · points go to the lab focus or the warehouse', netLabel: 'research' },
  { id: 'iron_mine', name: 'Iron Mine', tag: 'T0', buildCost: 60_000, unlockLevel: 5, cycleHours: 4,
    inputs: [r('mwh', 1)], outputs: [r('iron_ore', 100)], opCost: 380, upkeepPerDay: 150, netLabel: '+858' },
  { id: 'power_plant', name: 'Thermal Power', tag: 'Energy', buildCost: 120_000, unlockLevel: 5, cycleHours: 4,
    inputs: [r('coal', 50), r('water', 100)], outputs: [r('mwh', 15)], opCost: 150, upkeepPerDay: 300, netLabel: '+1,248' },
  { id: 'solar', name: 'Solar Farm', tag: 'Energy', buildCost: 250_000, unlockLevel: 12, cycleHours: 4,
    inputs: [], outputs: [r('mwh', 8)], opCost: 60, upkeepPerDay: 200, netLabel: '+1,322' },
  { id: 'steel_mill', name: 'Steel Mill', tag: 'T2', buildCost: 150_000, unlockLevel: 10, cycleHours: 4,
    inputs: [r('iron_ore', 100), r('coal', 50), r('mwh', 3)], outputs: [r('steel', 60)], opCost: 250, upkeepPerDay: 200, netLabel: '+1,547' },
  { id: 'chip_fab', name: 'Chip Fab', tag: 'T3', buildCost: 300_000, unlockLevel: 20, cycleHours: 4,
    inputs: [r('silicon_wafer', 20), r('mwh', 6)], outputs: [r('chip', 30)], opCost: 400, upkeepPerDay: 300, netLabel: '+2,033' },
  { id: 'car_factory', name: 'Car Factory', tag: 'T4', buildCost: 500_000, unlockLevel: 25, cycleHours: 8,
    inputs: [r('engine', 4), r('auto_parts', 8), r('glass', 10), r('mwh', 5)], outputs: [r('economy_car', 4)], opCost: 600, upkeepPerDay: 500, netLabel: '+2,992' },
  { id: 'watchmaker', name: 'Watchmaker', tag: 'T7', buildCost: 500_000, unlockLevel: 30, cycleHours: 8,
    inputs: [r('gold_bar', 1), r('movement_parts', 20), r('sapphire', 5)], outputs: [r('luxury_watch', 4)], opCost: 500, upkeepPerDay: 400, netLabel: '+3,734' },
  { id: 'luxury_store', name: 'Luxury Store', tag: 'Retail', buildCost: 300_000, unlockLevel: 30, cycleHours: 4,
    inputs: [], outputs: [], opCost: 300, upkeepPerDay: 400, summary: 'Sells T7 goods to player wallets at 1.2×–3× wholesale', netLabel: 'market' },
];

export const STARTING_CAPITAL = 100_000;
export const PLOTS_PER_COMPANY = 12;
/** Plots are laid out on a 4 × 3 isometric grid. */
export const PLOT_COLS = 4;

/** Exchange price bounds relative to reference price. */
export const PRICE_BAND = { min: 0.5, max: 2 } as const;

/** NPC buyer pays a falling share of reference as a company sells more of a product per day. */
export const NPC_BUYER_TIERS = [
  { upTo: 1000, factor: 1.0 },
  { upTo: 3000, factor: 0.9 },
  { upTo: 6000, factor: 0.8 },
  { upTo: Infinity, factor: 0.7 },
] as const;
