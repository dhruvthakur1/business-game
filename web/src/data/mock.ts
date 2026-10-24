/**
 * Demo data for the frontend while the API is not built.
 * Shapes mirror the planned tables (companies, buildings, orders, contracts, leagues…).
 */
import type { Building, LeagueName } from './types';

export const COMPANY = {
  name: 'Northwind Holdings',
  initials: 'NH',
  level: 12,
  xp: 7200,
  xpNext: 10_000,
  division: 'Small',
  region: 'North',
  day: 47,
  clock: '14:20',
  netWorth: 1_840_200,
  netWorthChange: 3.1,
  profit7d: 48_920,
  profitChange: 12.4,
  avgDailyOpProfit: 6988,
  league: 'Gold' as LeagueName,
  leagueRank: 6,
  season: { name: 'Season 3 · Iron Age', daysLeft: 12, tier: 17, tiers: 40, next: 'steel truck livery' },
};

export const START_CASH = 248_310;
export const START_WALLET = 61_200;

export const BUILDINGS: Building[] = [
  { id: 'b1', typeId: 'farm', name: 'Grain Farm 1', level: 4, status: 'ready', progress: 1, minutesLeft: 0, plot: { col: 0, row: 0 },
    readyOutput: { productId: 'wheat', qty: 400, quality: 1 }, netPerDay: 3656 },
  { id: 'b2', typeId: 'farm', name: 'Grain Farm 2', level: 3, status: 'running', progress: 0.64, minutesLeft: 86, plot: { col: 1, row: 0 }, netPerDay: 2742 },
  { id: 'b3', typeId: 'mill', name: 'Flour Mill', level: 3, status: 'running', progress: 0.22, minutesLeft: 187, plot: { col: 0, row: 1 }, netPerDay: 1629 },
  { id: 'b4', typeId: 'iron_mine', name: 'Iron Mine', level: 1, status: 'idle', progress: 0, minutesLeft: 0, plot: { col: 2, row: 0 }, netPerDay: 0 },
  { id: 'b5', typeId: 'bakery', name: 'Bakery', level: 3, status: 'ready', progress: 1, minutesLeft: 0, plot: { col: 1, row: 1 },
    readyOutput: { productId: 'bread', qty: 120, quality: 1 }, netPerDay: 5070 },
  { id: 'b6', typeId: 'supermarket', name: 'Supermarket', level: 2, status: 'running', progress: 0.5, minutesLeft: 120, plot: { col: 0, row: 2 }, netPerDay: 2880 },
  { id: 'b7', typeId: 'power_plant', name: 'Thermal Power', level: 2, status: 'running', progress: 0.81, minutesLeft: 46, plot: { col: 2, row: 1 }, netPerDay: 2496 },
  { id: 'b8', typeId: 'steel_mill', name: 'Steel Mill', level: 1, status: 'ready', progress: 1, minutesLeft: 0, plot: { col: 1, row: 2 },
    readyOutput: { productId: 'steel', qty: 60, quality: 0 }, netPerDay: 1547 },
  { id: 'b9', typeId: 'solar', name: 'Solar Farm', level: 1, status: 'construction', progress: 0.62, minutesLeft: 410, plot: { col: 2, row: 2 }, netPerDay: 0 },
];

export const CASHFLOW = [
  { day: 'D41', revenue: 9.8, costs: 6.9 },
  { day: 'D42', revenue: 10.4, costs: 7.1 },
  { day: 'D43', revenue: 11.1, costs: 7.0 },
  { day: 'D44', revenue: 10.9, costs: 7.4 },
  { day: 'D45', revenue: 12.6, costs: 7.2 },
  { day: 'D46', revenue: 13.4, costs: 7.6 },
  { day: 'D47', revenue: 14.2, costs: 7.3 },
];

export const ACTIVITY = [
  { time: '14:02', text: 'Contract C-1042 delivered on time', amount: 4320 },
  { time: '12:40', text: 'Ferro Labs passed you in Gold league', amount: -340 },
  { time: '00:00', text: 'Term loan installment paid', amount: -1718.83 },
  { time: 'D46', text: 'Flour reference price ▲ 4.2%', amount: null },
];

export interface MarketItem {
  id: string;
  price: number;
  change: number;
  ref: number;
  volume: string;
  /** 7 points, oldest first, for the sparkline */
  history: number[];
}

export const MARKET: MarketItem[] = [
  { id: 'wheat', price: 4.62, change: 1.8, ref: 4.55, volume: '412k', history: [4.45, 4.48, 4.5, 4.52, 4.55, 4.58, 4.62] },
  { id: 'flour', price: 8.34, change: 4.2, ref: 8.12, volume: '188k', history: [7.98, 8.0, 8.06, 8.04, 8.15, 8.2, 8.34] },
  { id: 'bread', price: 27.4, change: -0.9, ref: 27.1, volume: '61k', history: [27.9, 27.8, 27.6, 27.7, 27.5, 27.6, 27.4] },
  { id: 'steel', price: 24.8, change: 2.6, ref: 24.2, volume: '93k', history: [23.9, 24.0, 24.1, 24.2, 24.4, 24.5, 24.8] },
  { id: 'mwh', price: 41.2, change: -1.4, ref: 40.6, volume: '24k', history: [42.0, 41.9, 41.6, 41.7, 41.4, 41.3, 41.2] },
  { id: 'chip', price: 53.1, change: 0.6, ref: 52.4, volume: '11k', history: [52.6, 52.5, 52.8, 52.7, 52.9, 53.0, 53.1] },
  { id: 'luxury_watch', price: 912, change: -2.2, ref: 905, volume: '340', history: [935, 930, 925, 921, 918, 915, 912] },
];

export const ORDER_BOOK = {
  bids: [
    { price: 8.32, qty: 2400, q: 1 },
    { price: 8.3, qty: 1600, q: 0 },
    { price: 8.28, qty: 1200, q: 2 },
    { price: 8.25, qty: 800, q: 0 },
  ],
  asks: [
    { price: 8.36, qty: 900, q: 1 },
    { price: 8.38, qty: 1800, q: 2 },
    { price: 8.4, qty: 1300, q: 1 },
    { price: 8.45, qty: 3000, q: 0 },
  ],
};

export const CONTRACTS = [
  { id: 'C-1042', title: 'Flour → Harbor Bakeries', meta: 'sell · daily', status: 'On time', tone: 'gain' as const },
  { id: 'C-0988', title: 'Coal ← Ridgeback Mining', meta: 'buy · per cycle', status: 'Late 2h', tone: 'gold' as const },
  { id: 'C-1101', title: 'MWh → Ferro Labs', meta: 'sell · daily', status: 'Offered · 41h left', tone: 'muted' as const },
  { id: 'R-311', title: 'Iron ore ← open RFQ', meta: '4 sealed bids', status: 'Closes 18:00', tone: 'muted' as const },
];

export const RFQS = [
  { title: '2,400 flour Q1+ · daily for 14 days', meta: 'Harbor Bakeries · South · min reliability 80', max: 8.4, closes: 'closes in 9h', suggest: 8.25 },
  { title: '600 steel Q0+ · weekly for 30 days', meta: 'Atlas Autoworks · West · min reliability 85', max: 25.5, closes: 'closes in 17h', suggest: 24.9 },
  { title: '45 MWh · per cycle for 7 days', meta: 'Ferro Labs · North · min reliability 70', max: 42, closes: 'closes in 21h', suggest: 40.8 },
  { title: '1,000 bread Q2+ · one-off', meta: 'City Grocers Co-op · North · min reliability 75', max: 29, closes: 'closes in 3h', suggest: 28.1 },
];

export const SUPPLIERS = [
  { name: 'Ridgeback Mining', region: 'East · 4h', quality: 'Q1–Q2', price: 6.1, onTime: 950_000, total: 1_000_000, isNew: false },
  { name: 'Copperline Ltd', region: 'East · 4h', quality: 'Q0–Q1', price: 5.85, onTime: 230_000, total: 280_000, isNew: false },
  { name: 'Tundra Extraction', region: 'North · 1h', quality: 'Q0', price: 5.7, onTime: 0, total: 0, isNew: true },
];

export interface LeagueRow {
  rank: number;
  name: string;
  valueAdd: number;
  points: number;
  me?: boolean;
}

export const LEAGUE_GROUP: LeagueRow[] = [
  { rank: 1, name: 'Atlas Autoworks', valueAdd: 57_900, points: 1412 },
  { rank: 2, name: 'Copperline Ltd', valueAdd: 56_600, points: 1380 },
  { rank: 3, name: 'Harbor Bakeries', valueAdd: 53_400, points: 1301 },
  { rank: 4, name: 'Tundra Extraction', valueAdd: 52_000, points: 1268 },
  { rank: 5, name: 'Ferro Labs', valueAdd: 49_500, points: 1207 },
  { rank: 6, name: 'Northwind Holdings', valueAdd: 48_300, points: 1178, me: true },
  { rank: 7, name: 'Saltmarsh Foods', valueAdd: 45_400, points: 1107 },
  { rank: 8, name: 'Kestrel Power', valueAdd: 43_000, points: 1049 },
  { rank: 9, name: 'Bluegate Textiles', valueAdd: 41_800, points: 1019 },
  { rank: 26, name: 'Marrow & Sons', valueAdd: 12_100, points: 295 },
  { rank: 27, name: 'Quarry Nine', valueAdd: 9_400, points: 229 },
  { rank: 28, name: 'Pinecrest Paper', valueAdd: 7_700, points: 188 },
];

export const GLOBAL_AROUND_ME = [
  { rank: 479, name: 'Sable Logistics', value: 1_846_900 },
  { rank: 480, name: 'Orchid Cosmetics', value: 1_844_300 },
  { rank: 481, name: 'Ironvale Group', value: 1_842_600 },
  { rank: 482, name: 'Northwind Holdings', value: 1_841_400, me: true },
  { rank: 483, name: 'Lumen Glassworks', value: 1_839_000 },
  { rank: 484, name: 'Granite Bay Co', value: 1_833_700 },
  { rank: 485, name: 'Westwind Software', value: 1_829_100 },
];

export const RIVALS = [
  { name: 'Ferro Labs', profit7d: 52_100 },
  { name: 'Northwind Holdings', profit7d: 48_920, me: true },
  { name: 'Saltmarsh Foods', profit7d: 44_060 },
  { name: 'Harbor Bakeries', profit7d: 39_700 },
];

export const LEAGUES: LeagueName[] = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Tycoon'];
