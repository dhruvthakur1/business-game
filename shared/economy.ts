/**
 * Pure game-economy formulas from the business-logic report.
 * Everything here is deterministic and unit-tested; the server must use the same rules.
 */

export const CYCLES_PER_DAY = 6;
export const SELLER_FEE = 0.02;
export const CONTRACT_FEE = 0.01;

export interface LineItem {
  qty: number;
  price: number;
}

export interface RecipeEconomics {
  output: LineItem;
  inputs: LineItem[];
  opCost: number;
  upkeepPerDay: number;
  cyclesPerDay?: number;
  fee?: number;
}

/** net_per_day = cycles × (Q_out × P_out × (1 − fee) − Σ inputs − op_cost) − upkeep */
export function netPerDay(r: RecipeEconomics): number {
  const cycles = r.cyclesPerDay ?? CYCLES_PER_DAY;
  const fee = r.fee ?? SELLER_FEE;
  const revenue = r.output.qty * r.output.price * (1 - fee);
  const inputs = r.inputs.reduce((sum, i) => sum + i.qty * i.price, 0);
  return cycles * (revenue - inputs - r.opCost) - r.upkeepPerDay;
}

export function paybackDays(buildCost: number, net: number): number {
  return net > 0 ? buildCost / net : Infinity;
}

/** Cost to upgrade to level n = base × 1.12^(n−1). */
export function upgradeCost(baseCost: number, targetLevel: number): number {
  return baseCost * Math.pow(1.12, targetLevel - 1);
}

/** Op-cost multiplier from total company building levels; +0.6% per level above 20, capped at +30%. */
export function adminOverhead(totalLevels: number): number {
  return 1 + Math.min(0.3, 0.006 * Math.max(0, totalLevels - 20));
}

/** Plot n (n ≥ 13) costs 5,000 × 1.25^(n−13). The first 12 are free. */
export function plotCost(n: number): number {
  return n <= 12 ? 0 : 5000 * Math.pow(1.25, n - 13);
}

export type Quality = 0 | 1 | 2 | 3 | 4 | 5;

const clampQ = (q: number): Quality => Math.max(0, Math.min(5, q)) as Quality;

/** Output quality = min(floor(mean input quality) + research bonus, lowest input + 1). */
export function outputQuality(inputQualities: number[], researchBonus: number): Quality {
  if (inputQualities.length === 0) return clampQ(researchBonus);
  const mean = inputQualities.reduce((a, b) => a + b, 0) / inputQualities.length;
  const lowest = Math.min(...inputQualities);
  return clampQ(Math.min(Math.floor(mean) + researchBonus, lowest + 1));
}

export const npcPriceMultiplier = (q: number) => 1 + 0.08 * q;
export const retailSpeedMultiplier = (q: number) => 1 + 0.1 * q;

/** Daily-amortized installment: P × r × (1+r)^n / ((1+r)^n − 1). */
export function emi(principal: number, dailyRate: number, days: number): number {
  if (dailyRate === 0) return principal / days;
  const f = Math.pow(1 + dailyRate, days);
  return (principal * dailyRate * f) / (f - 1);
}

export interface CreditFactors {
  /** on-time repayment ratio, 0–1 */
  repayment: number;
  /** 1 − debt share, 0–1 */
  lowDebt: number;
  /** company age in days */
  ageDays: number;
  /** 7-day debt service coverage ratio */
  dscr: number;
  /** 1 − coefficient of variation of daily profit, 0–1 */
  stability: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function creditScore(f: CreditFactors): number {
  const a = clamp01(f.ageDays / 90);
  const c = clamp01(f.dscr / 2);
  const raw = 0.3 * clamp01(f.repayment) + 0.2 * clamp01(f.lowDebt) + 0.15 * a + 0.2 * c + 0.15 * clamp01(f.stability);
  return Math.round(300 + 600 * raw);
}

export interface RateTier {
  minScore: number;
  dailyRate: number | null;
  maxLtv: number;
  minDscr: number;
}

export const RATE_TIERS: RateTier[] = [
  { minScore: 800, dailyRate: 0.001, maxLtv: 0.65, minDscr: 1.25 },
  { minScore: 740, dailyRate: 0.0015, maxLtv: 0.6, minDscr: 1.35 },
  { minScore: 670, dailyRate: 0.002, maxLtv: 0.55, minDscr: 1.5 },
  { minScore: 580, dailyRate: 0.003, maxLtv: 0.45, minDscr: 1.75 },
  { minScore: 0, dailyRate: 0.004, maxLtv: 0.35, minDscr: 2.0 },
];

export function rateTier(score: number): RateTier {
  return RATE_TIERS.find((t) => score >= t.minScore) ?? RATE_TIERS[RATE_TIERS.length - 1];
}

/** Value-weighted Bayesian reliability with a 50k CR prior at 80%. */
export function reliability(onTimeValue: number, totalValue: number): number {
  return ((onTimeValue + 0.8 * 50_000) / (totalValue + 50_000)) * 100;
}

/** Contest points normalized to the division's last-week P90, capped at 1,500. */
export function contestPoints(metric: number, p90: number): number {
  if (p90 <= 0) return 0;
  return Math.min(1500, Math.round((1000 * metric) / p90));
}

/** Product designer: output value must not exceed inputs × max value-add + op cost. */
export function valueCheck(inputsValue: number, opCost: number, price: number, maxValueAdd = 1.8) {
  const max = inputsValue * maxValueAdd + opCost;
  return { max, pass: price <= max, marginPerUnit: price * (1 - SELLER_FEE) - inputsValue - opCost };
}

/** Progressive personal income tax on rolling 30-day inflows. */
export function personalIncomeTax(inflows30d: number): number {
  const bands: [number, number][] = [
    [50_000, 0],
    [500_000, 0.1],
    [5_000_000, 0.15],
    [Infinity, 0.25],
  ];
  let tax = 0;
  let floor = 0;
  for (const [ceiling, rate] of bands) {
    if (inflows30d <= floor) break;
    tax += (Math.min(inflows30d, ceiling) - floor) * rate;
    floor = ceiling;
  }
  return tax;
}

/** Freight = units × unit weight × hops × 0.02; an intra-region delivery counts as 0.25 hop. */
export function freightCost(units: number, unitWeight: number, hops: number): number {
  const effectiveHops = hops === 0 ? 0.25 : hops;
  return units * unitWeight * effectiveHops * 0.02;
}

export type Rarity = 'common' | 'limited' | 'unique';
const RARITY_MULT: Record<Rarity, number> = { common: 1, limited: 1.5, unique: 3 };

/** item prestige = 100 × log10(price / 1,000) × rarity multiplier (never negative). */
export function itemPrestige(price: number, rarity: Rarity = 'common'): number {
  return Math.max(0, 100 * Math.log10(price / 1000) * RARITY_MULT[rarity]);
}

/** Salary cap: 15% of 7-day average daily operating profit. */
export const maxDailySalary = (avgDailyOpProfit7d: number) => Math.max(0, 0.15 * avgDailyOpProfit7d);
