export interface ContestLine {
  what: string;
  why: string;
  value: string;
  counted: boolean;
}

export interface Contest {
  id: string;
  name: string;
  cadence: 'weekly' | 'monthly' | 'co-op';
  cadenceLong: string;
  pitch: string;
  rank: string;
  score: string;
  endsInMinutes: number;
  formula: string;
  lines: ContestLine[];
  rules: string[];
  board: { rank: string; name: string; points: string; me?: boolean }[];
  rewards: { band: string; prize: string }[];
  /** 0–1 progress shown on the league page card */
  progress: number;
}

const ok = (what: string, why: string, value: string): ContestLine => ({ what, why, value, counted: true });
const no = (what: string, why: string, value: string): ContestLine => ({ what, why, value, counted: false });

export const CONTESTS: Contest[] = [
  {
    id: 'supplier', name: 'Reliable Supplier Week', cadence: 'weekly', cadenceLong: 'Weekly contest · week 43',
    pitch: 'Deliver contracted goods on time to many different buyers. Rewards the companies other players can count on.',
    rank: '#3', score: '1,240', endsInMinutes: 3728, progress: 0.83,
    formula: 'metric = Σ on-time delivered contract value\n  only buyers that are not linked to you\n  needs 3+ unique buyers this week',
    lines: [
      ok('C-1042 · flour to Harbor Bakeries', '6 deliveries, all inside the window', '+11,808'),
      ok('C-1077 · bread to City Grocers', '2 deliveries on time', '+2,240'),
      no('C-0988 · coal you bought', 'You were the buyer; only sales count', '0'),
      no('C-1090 · flour to Westmill Co', 'Linked account (same device). Excluded from all scores.', '0'),
    ],
    rules: [
      'Bayesian reliability of 70 or more to enter',
      'Late deliveries count at 50%; breaches remove the whole contract',
      'Prices outside 0.85–1.15× reference are excluded',
      'Bankrupt companies sit out one weekly cycle',
    ],
    board: [
      { rank: '#1', name: 'Copperline Ltd', points: '1,412' },
      { rank: '#2', name: 'Harbor Bakeries', points: '1,301' },
      { rank: '#3', name: 'Northwind Holdings', points: '1,240', me: true },
      { rank: '#4', name: 'Ridgeback Mining', points: '1,198' },
      { rank: '#5', name: 'Saltmarsh Foods', points: '1,102' },
    ],
    rewards: [
      { band: '#1', prize: 'Gold verified-supplier badge glow + 25,000 CR (capped)' },
      { band: 'Top 3', prize: 'Silver badge glow for 4 weeks' },
      { band: 'Top 10', prize: 'Profile ribbon "Reliable"' },
      { band: 'Entered', prize: 'Checkpoint cosmetic drop at 500 points' },
    ],
  },
  {
    id: 'margin', name: 'Margin Master', cadence: 'weekly', cadenceLong: 'Weekly contest · week 43',
    pitch: 'Run the leanest operation. Score your gross margin, with a volume gate so tiny shops cannot game it.',
    rank: '#9', score: '804', endsInMinutes: 3728, progress: 0.62,
    formula: 'metric = (revenue − COGS) ÷ revenue\n  revenue from NPCs + unlinked players\n  needs 20,000 CR revenue this week',
    lines: [
      ok('Revenue this week', 'NPC buyers and unlinked players', '61,420'),
      ok('Cost of goods sold', 'Inputs at lot cost, op costs, wages', '−42,260'),
      no('Sale of Iron Mine equipment', 'Asset sales are not revenue', '0'),
      ok('Gross margin', 'Above the 20k volume gate', '31.2%'),
    ],
    rules: [
      'Minimum 20,000 CR revenue',
      'Internal transfers between your own buildings do not count',
      'Asset sales, loan proceeds and owner injections excluded',
    ],
    board: [
      { rank: '#1', name: 'Orchid Cosmetics', points: '1,500' },
      { rank: '#2', name: 'Lumen Glassworks', points: '1,288' },
      { rank: '#8', name: 'Bluegate Textiles', points: '831' },
      { rank: '#9', name: 'Northwind Holdings', points: '804', me: true },
      { rank: '#10', name: 'Kestrel Power', points: '790' },
    ],
    rewards: [
      { band: '#1', prize: 'Title "Margin Master" for 7 days' },
      { band: 'Top 3', prize: 'Ledger-green profile frame' },
      { band: 'Top 10', prize: 'Research-point bundle (capped)' },
      { band: 'Entered', prize: 'Checkpoint cosmetic drop' },
    ],
  },
  {
    id: 'harvest', name: 'Harvest Sprint', cadence: 'weekly', cadenceLong: 'Weekly contest · week 43',
    pitch: 'Sell the most agricultural units per building level. Small farms with full order books do well here.',
    rank: '#14', score: '620', endsInMinutes: 3728, progress: 0.41,
    formula: 'metric = agricultural units sold ÷ your T1 building levels\n  NPC sales and contracts both count',
    lines: [
      ok('Wheat sold to NPC buyers', '1,400 units', '+1,400'),
      ok('Wheat delivered on contracts', '2,800 units', '+2,800'),
      no('Wheat moved to your own mill', 'Internal transfers do not count', '0'),
      ok('Per building level', '4,200 units ÷ 7 levels', '600'),
    ],
    rules: ['Requires at least one T1 building', 'Self-trades and linked-account trades excluded'],
    board: [
      { rank: '#1', name: 'Saltmarsh Foods', points: '1,388' },
      { rank: '#2', name: 'Fieldline Co-op', points: '1,204' },
      { rank: '#13', name: 'Harbor Bakeries', points: '644' },
      { rank: '#14', name: 'Northwind Holdings', points: '620', me: true },
      { rank: '#15', name: 'Pinecrest Paper', points: '598' },
    ],
    rewards: [
      { band: '#1', prize: '"Golden Sickle" profile frame' },
      { band: 'Top 10', prize: 'Harvest banner for your storefront' },
      { band: 'Entered', prize: 'Checkpoint cosmetic drop' },
    ],
  },
  {
    id: 'community', name: 'Harbor Stadium', cadence: 'co-op', cadenceLong: 'Community project · server-wide',
    pitch: 'Everyone builds one landmark together. Deliver cement, steel and planks; every checkpoint unlocks rewards for all contributors.',
    rank: '#412', score: '1,800 cement', endsInMinutes: 7320, progress: 0.62,
    formula: 'progress = Σ goods delivered by all players\n  checkpoints at 25 / 50 / 75 / 100%\n  top 10 contributors named on the monument',
    lines: [
      ok('1,800 cement delivered', 'Counted toward the 40,000 goal', '+1,800'),
      ok('Checkpoint 50% reached', 'Stadium lights cosmetic unlocked for you', '✓'),
      no('Checkpoint 75%', 'Server is at 62%', '—'),
      ok('Your share', 'Top 15% of contributors', '4.5%'),
    ],
    rules: [
      'One delivery of any listed good makes you a contributor',
      'Deliveries are valued at reference price',
      'No CR prizes: rewards are cosmetic and shared',
    ],
    board: [
      { rank: '#1', name: 'Granite Bay Co', points: '9,400' },
      { rank: '#2', name: 'Atlas Autoworks', points: '8,950' },
      { rank: '#3', name: 'Ironvale Group', points: '7,100' },
      { rank: '#412', name: 'Northwind Holdings', points: '1,800', me: true },
    ],
    rewards: [
      { band: '25%', prize: 'Stadium flag for your HQ' },
      { band: '50%', prize: 'Stadium lights (unlocked)' },
      { band: '75%', prize: 'Matchday avatar outfit' },
      { band: '100%', prize: 'Monument plaque · top 10 named' },
    ],
  },
  {
    id: 'championship', name: 'Tycoon Championship', cadence: 'monthly', cadenceLong: 'Monthly final · October',
    pitch: 'The top 30 of each division’s Diamond and higher leagues meet in a final. Your score is the sum of your four weekly contest points.',
    rank: '—', score: 'not qualified', endsInMinutes: 13_320, progress: 0,
    formula: 'score = Σ points from the 4 weekly contests\n  qualify: top 30 of Diamond+ leagues in your division',
    lines: [
      no('Your league is Gold', 'Diamond or higher is needed to qualify', '—'),
      ok('Path', 'Promote twice: Gold → Platinum → Diamond', '2 weeks'),
      ok('Last month’s winner', 'Copperline Ltd · Small division', '5,212'),
      ok('Spectator rewards', 'Predict the top 3 for a cosmetic', 'open'),
    ],
    rules: [
      'Top 30 of Diamond, Master and Tycoon leagues per division',
      'Linked accounts and wash trades excluded as in weekly contests',
      'Ties go to the earlier achiever',
    ],
    board: [
      { rank: '#1', name: 'Copperline Ltd', points: '5,212' },
      { rank: '#2', name: 'Atlas Autoworks', points: '5,034' },
      { rank: '#3', name: 'Sable Logistics', points: '4,870' },
      { rank: '#4', name: 'Orchid Cosmetics', points: '4,612' },
    ],
    rewards: [
      { band: '#1', prize: 'Numbered trophy car (no CR value) + title' },
      { band: 'Top 3', prize: 'Championship podium frame' },
      { band: 'Top 30', prize: 'Finalist badge for the season' },
      { band: 'Fans', prize: 'Prediction cosmetic' },
    ],
  },
];
