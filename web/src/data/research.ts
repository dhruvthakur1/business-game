/** Cumulative research points to reach Q1–Q5 in a family. */
export const RESEARCH_THRESHOLDS = [50, 250, 1500, 6000, 20000] as const;

export interface ResearchFamily {
  id: string;
  name: string;
  color: string;
  points: number;
  unlocks: [string, string, string, string, string];
}

export const RESEARCH_FAMILIES: ResearchFamily[] = [
  { id: 'agri', name: 'Agri', color: 'var(--t1)', points: 1620, unlocks: ['Fertilizer mix · +5% yield', 'Cotton & coffee seeds', 'Greenhouses', 'Precision farming · +10% yield', 'Heirloom crops'] },
  { id: 'food', name: 'Food', color: 'var(--t4)', points: 410, unlocks: ['Pastries', 'Cheese', 'Packaged meals', 'Chocolate', 'Haute cuisine'] },
  { id: 'textiles', name: 'Textiles', color: 'var(--master-fg)', points: 0, unlocks: ['Fine fabric', 'Denim & jeans', 'Dyes & prints', 'Silk weaving', 'Couture'] },
  { id: 'metals', name: 'Metals', color: '#e07b39', points: 260, unlocks: ['Alloy steel', 'Aluminium', 'Copper wire', 'Precision casting', 'Aerospace alloys'] },
  { id: 'electronics', name: 'Electronics', color: 'var(--t2)', points: 0, unlocks: ['Circuit boards', 'Display panels', 'Phone batteries', 'Advanced chips', 'Server racks'] },
  { id: 'auto', name: 'Auto', color: 'var(--t6)', points: 0, unlocks: ['Tires', 'Engines', 'EV battery packs', 'SUVs', 'Sports cars'] },
  { id: 'luxury', name: 'Luxury', color: 'var(--gold)', points: 0, unlocks: ['Cut gems', 'Watch movement parts', 'Haute-couture line', 'Diamond rings', 'Hypercar trim'] },
  { id: 'energy', name: 'Energy', color: 'var(--t5)', points: 90, unlocks: ['Grid storage', 'Solar panels', 'Efficient turbines · −10% coal', 'Wind farms', 'Smart grid'] },
];

export const LAB_RP_PER_DAY = 140;

export type NodeState = 'done' | 'current' | 'locked';

export function nodeState(points: number, tierIndex: number): { state: NodeState; progress: number } {
  const prev = tierIndex === 0 ? 0 : RESEARCH_THRESHOLDS[tierIndex - 1];
  const thr = RESEARCH_THRESHOLDS[tierIndex];
  if (points >= thr) return { state: 'done', progress: 1 };
  if (points >= prev) return { state: 'current', progress: (points - prev) / (thr - prev) };
  return { state: 'locked', progress: 0 };
}
