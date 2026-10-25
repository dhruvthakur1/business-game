/**
 * Season pass: every 4 league weeks (28 game days) a new season starts. XP earned during the season fills
 * 40 tiers; each tier has one reward to claim: wallet cash, research points, a truck livery, a profile
 * title, and a trophy at the top.
 */

export const SEASON_DAYS = 28;
export const SEASON_TIERS = 40;
export const XP_PER_TIER = 400;

export const SEASON_NAMES = ['Iron Age', 'Steam Age', 'Electric Age', 'Jet Age', 'Silicon Age', 'Atomic Age', 'Space Age', 'Gilded Age'];
export const seasonName = (n: number) => SEASON_NAMES[(n - 1) % SEASON_NAMES.length];

const LIVERIES = ['Steel truck livery', 'Harvest gold livery', 'Midnight blue livery', 'Racing red livery', 'Chrome livery', 'Carbon livery', 'Copper livery', 'Pearl livery'];
const TITLES = ['Apprentice Merchant', 'Master of Trade', 'Industrialist'];

export type SeasonReward =
  | { kind: 'wallet'; amount: number }
  | { kind: 'research'; amount: number }
  | { kind: 'livery'; name: string }
  | { kind: 'title'; name: string }
  | { kind: 'trophy'; name: string };

/** The reward on a tier (1–40) of season `n`. Cosmetic names are tied to the season so each season adds new ones. */
export function tierReward(n: number, tier: number): SeasonReward {
  const step = 1 + Math.floor(tier / 10);
  if (tier === SEASON_TIERS) return { kind: 'trophy', name: `${seasonName(n)} Tycoon` };
  if (tier % 10 === 0) return { kind: 'title', name: `${TITLES[tier / 10 - 1]} · S${n}` };
  if (tier % 5 === 0) return { kind: 'livery', name: `${LIVERIES[(tier / 5 - 1 + (n - 1) * 2) % LIVERIES.length]} · S${n}` };
  if (tier % 2 === 1) return { kind: 'wallet', amount: 250 * step };
  return { kind: 'research', amount: 25 * step };
}

export function rewardLabel(r: SeasonReward): string {
  switch (r.kind) {
    case 'wallet': return `${r.amount.toLocaleString('en-US')} CR to your wallet`;
    case 'research': return `${r.amount} research points`;
    case 'livery': return r.name;
    case 'title': return `Title: ${r.name}`;
    case 'trophy': return `Trophy: ${r.name}`;
  }
}

/** Tier reached with this much season XP (0–40). */
export const seasonTier = (xp: number) => Math.min(SEASON_TIERS, Math.floor(Math.max(0, xp) / XP_PER_TIER));
