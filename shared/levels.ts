import { STARTER_LOAN, TERM_LOAN } from './bank';
import { BUILDING_TYPE_DEFS } from './catalog';
import { CONTRACT_RULES } from './contracts';

/**
 * Company XP and levels. XP comes from real economic activity:
 * - production: value added by a collected job (output minus inputs, at base reference prices);
 * - contracts: value of deliveries made (sellers earn most; late deliveries earn half);
 * - trading: exchange fills and NPC sales, capped per game day so churn can't farm levels.
 */

export const MAX_LEVEL = 60;

/** XP per CR of production value-add. A level-1 farm cycle adds ~298 CR → 59 XP. */
export const XP_PER_CR_VALUE_ADD = 0.2;
/** XP per CR delivered under a contract, for the seller (halved if late) and the buyer. */
export const XP_PER_CR_CONTRACT_SELLER = 0.05;
export const XP_PER_CR_CONTRACT_BUYER = 0.01;
/** XP per CR traded on the exchange (each side) or sold to NPC buyers. */
export const XP_PER_CR_TRADE = 0.01;

/** Daily caps per game day. */
export const XP_CAPS = {
  /** Exchange fills, contract purchases and NPC sales together. */
  market: 400,
  /** Contract deliveries to any one buyer. */
  contractPerBuyer: 300,
} as const;

/** Total XP needed to reach a level: XP to go from level l to l+1 grows 25% per level, starting at 1,000. */
export function xpForLevel(level: number): number {
  return Math.round(4000 * (Math.pow(1.25, level - 1) - 1));
}

export function levelForXp(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && xpForLevel(level + 1) <= xp) level += 1;
  return level;
}

/** Progress inside the current level, for progress bars. */
export function levelProgress(xp: number, level: number) {
  const start = xpForLevel(level);
  const end = xpForLevel(Math.min(MAX_LEVEL, level + 1));
  return { intoLevel: Math.max(0, xp - start), levelSize: Math.max(1, end - start), nextLevelAt: end };
}

/** Features that unlock at a level, besides buildings (which carry their own unlock level). */
export const FEATURE_UNLOCKS: { level: number; name: string }[] = [
  { level: STARTER_LOAN.minLevel, name: 'Starter loan' },
  { level: CONTRACT_RULES.minLevel, name: 'Supply contracts & RFQs' },
  { level: TERM_LOAN.minLevel, name: 'Term loans' },
];

/** Everything that unlocks exactly at `level`. */
export function unlocksAt(level: number): string[] {
  return [
    ...BUILDING_TYPE_DEFS.filter((b) => b.unlockLevel === level).map((b) => b.name),
    ...FEATURE_UNLOCKS.filter((f) => f.level === level).map((f) => f.name),
  ];
}

/** The next level above `level` that unlocks something, and what. */
export function nextUnlock(level: number): { level: number; names: string[] } | null {
  for (let l = level + 1; l <= MAX_LEVEL; l++) {
    const names = unlocksAt(l);
    if (names.length) return { level: l, names };
  }
  return null;
}
