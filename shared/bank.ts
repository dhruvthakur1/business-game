/** Bank and upkeep rules (section 8 of the report). Amounts in CR, rates as daily fractions. */

export const STARTER_LOAN = { amount: 20_000, days: 14, dailyRate: 0.001, minLevel: 2 } as const;

export const TERM_LOAN = {
  minLevel: 5,
  minAgeDays: 3,
  terms: [14, 30, 45, 60] as readonly number[],
  /** Max principal = this × 7-day average daily operating cash flow. */
  limitMultiple: 10,
  minAmount: 5_000,
  /** Scores below this are declined outright. */
  minScore: 500,
} as const;

export const OVERDRAFT = { limit: 5_000, dailyRate: 0.005, drawFee: 50 } as const;

export const DELINQUENCY = {
  lateFeePct: 0.02,
  penaltyRate: 0.001,
  missedScorePenalty: 15,
  onTimeScoreRecovery: 5,
  restructureAtDays: 3,
  restructureRateBump: 0.0005,
  restructureScorePenalty: 30,
  borrowBlockDays: 14,
  collectionsAtDays: 7,
  collectionsSweepPct: 0.5,
  receivershipAtDays: 14,
} as const;

export const RECEIVERSHIP = {
  /** Inventory sells at this share of min(base, reference) price. */
  inventoryFactor: 0.8,
  /** Buildings sell to the NPC at this share of resale value (resale = 70% of invested). */
  buildingFactor: 0.6,
  resaleFactor: 0.7,
} as const;

export const BANKRUPTCY = { restartCash: 50_000, score: 450 } as const;

export type LoanProduct = 'starter' | 'term' | 'overdraft';
export type LoanStatus = 'active' | 'late' | 'restructure_offered' | 'collections' | 'repaid' | 'defaulted';
