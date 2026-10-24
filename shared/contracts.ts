/** Supply contract and RFQ rules (section 7 of the report). Hours are game hours. */

export const CONTRACT_RULES = {
  /** Fee on each settled delivery, taken from the seller's proceeds (vs 2% on the exchange). */
  feePct: 0.01,
  /** Seller's performance bond: this share of 7 days of contract value. */
  bondPct: 0.1,
  frequencies: [4, 24, 168] as readonly number[],
  windows: [4, 8, 24] as readonly number[],
  maxTermDays: 30,
  /** Unanswered offers expire after this many game hours. */
  offerHours: 48,
  /** Gap between acceptance and the first delivery window. */
  firstWindowDelayHours: 1,
  /** Late delivery: 1% of the delivery value per game hour, capped at 10%, paid from the bond to the buyer. */
  latePctPerHour: 0.01,
  lateCapPct: 0.1,
  /** A delivery not made within this many hours after its window closes is a breach. */
  breachAfterHours: 24,
  sellerBreachPct: 0.1,
  buyerUnfundedPct: 0.05,
  noticeHours: 72,
  /** This many breaches in 30 game days suspends contract creation for 7 game days. */
  breachLimit: 3,
  breachLookbackDays: 30,
  suspensionDays: 7,
  /** Contracts unlock at this company level (gates contract theft by throwaway companies). */
  minLevel: 5,
} as const;

export const RFQ_RULES = {
  /** Sealed-bid window. */
  biddingHours: 24,
  /** Unawarded RFQs expire this long after bidding closes. */
  awardHours: 48,
} as const;

/** Value-weighted Bayesian reliability with a 50,000 CR prior at 80%. */
export const RELIABILITY = { priorCr: 50_000, priorScore: 0.8, minCounterparties: 3 } as const;

export type ContractStatus = 'offered' | 'rejected' | 'expired' | 'withdrawn' | 'active' | 'completed' | 'terminated_by_notice' | 'terminated_for_breach';
export type DeliveryStatus = 'pending' | 'funded' | 'unfunded' | 'settled' | 'breached' | 'cancelled';

export interface ContractTerms {
  productId: string;
  /** Units per delivery. */
  qty: number;
  minQuality: number;
  priceCents: number;
  frequencyHours: number;
  windowHours: number;
  termDays: number;
}

export const deliveryCount = (t: Pick<ContractTerms, 'termDays' | 'frequencyHours'>) =>
  Math.max(1, Math.floor((t.termDays * 24) / t.frequencyHours));

export const deliveryValueCents = (t: Pick<ContractTerms, 'qty' | 'priceCents'>) => t.qty * t.priceCents;

/** 10% of the value of the deliveries in the first 7 days. */
export const bondCents = (t: ContractTerms) =>
  Math.round(CONTRACT_RULES.bondPct * Math.min(deliveryCount(t), Math.ceil((7 * 24) / t.frequencyHours)) * deliveryValueCents(t));

export const frequencyLabel = (h: number) => (h === 4 ? 'every cycle (4h)' : h === 24 ? 'daily' : h === 168 ? 'weekly' : `every ${h}h`);
