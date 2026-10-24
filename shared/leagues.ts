/** Weekly leagues and contests (section 10 of the report). Amounts in CR. */

export const GROUP_SIZE = 30;
/** In a full group of 30: top 7 promote, bottom 5 relegate. Smaller groups scale these down. */
export const PROMOTE_PER_30 = 7;
export const RELEGATE_PER_30 = 5;
export const MAX_POINTS = 1500;
/** A game week is 7 game days. */
export const WEEK_DAYS = 7;

export const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Tycoon'] as const;
export type Tier = (typeof TIERS)[number];

export interface Division {
  id: 'startup' | 'small' | 'mid' | 'large' | 'conglomerate';
  name: string;
  /** Lower bound of conservative net worth, CR. */
  minNetWorth: number;
  /** Scales metric baselines and prize caps. */
  scale: number;
  prizeMultiplier: number;
}

export const DIVISIONS: Division[] = [
  { id: 'startup', name: 'Startup', minNetWorth: 0, scale: 1, prizeMultiplier: 0.2 },
  { id: 'small', name: 'Small', minNetWorth: 250_000, scale: 15, prizeMultiplier: 0.5 },
  { id: 'mid', name: 'Mid', minNetWorth: 2_000_000, scale: 100, prizeMultiplier: 1 },
  { id: 'large', name: 'Large', minNetWorth: 20_000_000, scale: 600, prizeMultiplier: 2 },
  { id: 'conglomerate', name: 'Conglomerate', minNetWorth: 200_000_000, scale: 3000, prizeMultiplier: 4 },
];

export function divisionFor(netWorthCr: number): Division {
  return [...DIVISIONS].reverse().find((d) => netWorthCr >= d.minNetWorth) ?? DIVISIONS[0];
}

export const promoteCount = (groupSize: number) => (groupSize <= 0 ? 0 : Math.ceil((groupSize * PROMOTE_PER_30) / GROUP_SIZE));
export const relegateCount = (groupSize: number) => Math.floor((groupSize * RELEGATE_PER_30) / GROUP_SIZE);

/** points = min(1,500, 1,000 × metric ÷ last week's 90th percentile in the division). */
export function contestPoints(metric: number, p90: number): number {
  if (p90 <= 0 || metric <= 0) return 0;
  return Math.min(MAX_POINTS, Math.round((1000 * metric) / p90));
}

/** CR prize cap: min(25,000 × division multiplier, 5% of the division's median weekly profit). */
export function prizeCap(division: Division, medianWeeklyProfitCr: number): number {
  return Math.max(0, Math.min(25_000 * division.prizeMultiplier, 0.05 * medianWeeklyProfitCr));
}

export type ContestId = 'industry' | 'harvest_sprint' | 'margin_master' | 'reliable_supplier' | 'power_rush' | 'quality_quest' | 'balance_sheet' | 'newcomer_cup';

export interface ContestDef {
  id: ContestId;
  name: string;
  pitch: string;
  formula: string;
  rules: string[];
  /** How the metric is shown. */
  unit: 'cr' | 'units' | 'pct' | 'units_per_level';
  /** Startup-division stand-in for last week's P90 when there is no history yet. */
  baseline: number;
  /** Whether the baseline scales with division size (money and volume do; ratios don't). */
  scales: boolean;
  rewards: { band: string; prize: string }[];
}

export const CONTESTS: ContestDef[] = [
  {
    id: 'industry', name: 'Industry League', unit: 'cr', baseline: 25_000, scales: true,
    pitch: 'The permanent weekly league. Score the value your production adds, and climb from Bronze to Tycoon.',
    formula: 'metric = Σ value added by collected jobs this week\n  value added = output − inputs, at base reference prices',
    rules: ['Grouped with up to 30 companies in your division and tier', 'Top 7 of 30 promote, bottom 5 relegate (scaled for smaller groups)', 'A company with 0 points cannot be promoted'],
    rewards: [{ band: '#1', prize: 'League badge + capped CR prize' }, { band: 'Promotion zone', prize: 'Move up a tier' }, { band: 'Relegation zone', prize: 'Move down a tier' }],
  },
  {
    id: 'harvest_sprint', name: 'Harvest Sprint', unit: 'units_per_level', baseline: 600, scales: false,
    pitch: 'Sell the most agricultural produce per farm level. Small farms with full order books do well here.',
    formula: 'metric = T1 units sold (NPC buyers + contract deliveries) ÷ your T1 building levels',
    rules: ['Requires at least one T1 building', 'Exchange trades and internal transfers do not count'],
    rewards: [{ band: '#1', prize: '"Golden Sickle" profile frame + capped CR' }, { band: 'Top 10', prize: 'Harvest banner for your storefront' }, { band: '500+ pts', prize: 'Checkpoint cosmetic' }],
  },
  {
    id: 'margin_master', name: 'Margin Master', unit: 'pct', baseline: 0.3, scales: false,
    pitch: 'Run the leanest operation. Score your margin, with a volume gate so tiny shops cannot game it.',
    formula: 'metric = (revenue − costs) ÷ revenue\n  revenue: NPC sales, exchange and contract proceeds\n  costs: op costs, upkeep, NPC, exchange and contract purchases\n  needs 20,000 CR revenue this week',
    rules: ['Minimum 20,000 CR revenue this week', 'Loans, asset sales and building purchases are excluded'],
    rewards: [{ band: '#1', prize: 'Title "Margin Master" for 7 days + capped CR' }, { band: 'Top 3', prize: 'Ledger-green profile frame' }, { band: '500+ pts', prize: 'Checkpoint cosmetic' }],
  },
  {
    id: 'reliable_supplier', name: 'Reliable Supplier Week', unit: 'cr', baseline: 8_000, scales: true,
    pitch: 'Deliver contracted goods on time to many different buyers. Rewards the companies other players can count on.',
    formula: 'metric = Σ contract value you delivered on time this week\n  late deliveries count at 50%\n  needs 3+ unique buyers this week',
    rules: ['Reliability of 70 or more to enter', 'Contract prices outside 0.85–1.15× reference are excluded', 'A breached contract removes all its deliveries'],
    rewards: [{ band: '#1', prize: 'Gold verified-supplier badge glow + capped CR' }, { band: 'Top 3', prize: 'Silver badge glow for 4 weeks' }, { band: '500+ pts', prize: 'Checkpoint cosmetic' }],
  },
  {
    id: 'power_rush', name: 'Power Rush', unit: 'units', baseline: 150, scales: true,
    pitch: 'Keep the grid running. Score the electricity you supply to other companies.',
    formula: 'metric = MWh sold on the exchange + MWh delivered under contracts',
    rules: ['Sales to yourself are impossible; NPC sales do not count', 'Trades priced outside 0.85–1.15× reference are excluded'],
    rewards: [{ band: '#1', prize: 'Power-line avatar effect + capped CR' }, { band: 'Top 10', prize: 'Grid badge' }, { band: '500+ pts', prize: 'Checkpoint cosmetic' }],
  },
  {
    id: 'quality_quest', name: 'Quality Quest', unit: 'units', baseline: 400, scales: true,
    pitch: 'Better inputs make better goods. Score the units you sell at quality 2 or higher.',
    formula: 'metric = units sold at Q2+ (exchange, contracts, NPC buyers)',
    rules: ['Exchange trades priced outside 0.85–1.15× reference are excluded'],
    rewards: [{ band: '#1', prize: 'Research-point bundle (capped) + capped CR' }, { band: 'Top 3', prize: 'Gold quality frame on your storefront' }, { band: '500+ pts', prize: 'Checkpoint cosmetic' }],
  },
  {
    id: 'balance_sheet', name: 'Balance Sheet Builder', unit: 'cr', baseline: 10_000, scales: true,
    pitch: 'Grow conservative net worth. Loans don’t help: debt is subtracted.',
    formula: 'metric = net worth now − net worth when the week started\n  net worth = assets − debt (loans, overdraft, unpaid upkeep)',
    rules: ['Borrowing is neutral: cash in, debt in', 'Only growth counts; a shrinking balance sheet scores 0'],
    rewards: [{ band: '#1', prize: '"Iron Ledger" trophy + capped CR' }, { band: 'Top 3', prize: 'Ledger profile frame' }, { band: '500+ pts', prize: 'Checkpoint cosmetic' }],
  },
  {
    id: 'newcomer_cup', name: 'Newcomer Cup', unit: 'cr', baseline: 4_000, scales: true,
    pitch: 'For companies under 30 game days old. Score this week’s operating cash flow.',
    formula: 'metric = operating cash flow this week\n  (sales − purchases − op costs − upkeep)',
    rules: ['Company must be younger than 30 game days', 'Loans and building purchases are excluded'],
    rewards: [{ band: '#1', prize: 'Starter luxury item (non-tradeable) + capped CR' }, { band: 'Top 3', prize: 'Newcomer ribbon' }, { band: '500+ pts', prize: 'Checkpoint cosmetic' }],
  },
];

export const contestById = (id: string) => CONTESTS.find((c) => c.id === id);

const ROTATION: ContestId[] = ['harvest_sprint', 'margin_master', 'reliable_supplier', 'power_rush', 'quality_quest', 'balance_sheet', 'newcomer_cup'];

/** Three rotating contests per week, cycling through the pool. */
export function weeklyContests(week: number): ContestId[] {
  const start = ((week * 3) % ROTATION.length + ROTATION.length) % ROTATION.length;
  return [0, 1, 2].map((i) => ROTATION[(start + i) % ROTATION.length]);
}

/** Metric stand-in for P90 when the division has no closed week to learn from. */
export const baselineP90 = (c: ContestDef, d: Division) => (c.scales ? c.baseline * d.scale : c.baseline);

/** Points needed for the "entered" checkpoint cosmetic. */
export const CHECKPOINT_POINTS = 500;
