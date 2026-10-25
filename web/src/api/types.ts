/** Response shapes of the Mercantile API (see server/src/app.ts). Money is in cents. */
import type { TemplateId, VariantTier } from '../../../shared/designer';
import type { FamilyId } from '../../../shared/research';

export interface ServerCompany {
  id: string;
  name: string;
  region: string;
  level: number;
}

export interface ServerJob {
  id: string;
  startedAt: string;
  finishesAt: string;
  outputProduct: string | null;
  outputQty: number;
  outputQuality: number;
}

export interface ServerBuilding {
  id: string;
  typeId: string;
  name: string;
  level: number;
  plot: number;
  designId: string | null;
  job: ServerJob | null;
}

export interface InventoryLot {
  productId: string;
  quality: number;
  qty: number;
}

export interface XpSummary {
  total: number;
  level: number;
  intoLevel: number;
  levelSize: number;
  nextLevelAt: number;
  nextUnlock: { level: number; names: string[] } | null;
  recent: { amount: number; source: string; note: string; at: string }[];
}

export interface MeResponse {
  company: ServerCompany;
  xp: XpSummary;
  league: { week: number; endsAt: string; tier: LeagueTier; division: string; rank: number; groupSize: number } | null;
  serverTime: string;
  timeScale: number;
  cashCents: number;
  escrowCents: number;
  debtCents: number;
  upkeepArrearsCents: number;
  netWorthCents: number;
  operatingCashFlow7dCents: number;
  openOrders: number;
  inventory: InventoryLot[];
  buildings: ServerBuilding[];
  research: Record<FamilyId, number>;
  designs: ServerDesign[];
}

/** A branded product made with the product designer. Its id is a product id. */
export interface ServerDesign {
  id: string;
  name: string;
  priceCents: number;
  brandId: string;
  brandName: string;
  companyId: string;
  templateId: TemplateId;
  buildingTypeId: string;
  baseProductId: string;
  tier: VariantTier;
  slots: Record<string, number>;
  art: string;
}

export interface ResearchFamilyView {
  id: FamilyId;
  name: string;
  points: number;
  tier: number;
  next: number | null;
  planned: string[];
  firsts: { tier: number; companyName: string; mine: boolean; at: string }[];
}

export interface ResearchResponse {
  thresholds: number[];
  focus: FamilyId | null;
  rpOnHand: number;
  rpPerDay: number;
  labs: { id: string; name: string; level: number; running: boolean; rpPerCycle: number }[];
  innovation: { rank: number; of: number; totalPoints: number; firstBonusXp: number };
  families: ResearchFamilyView[];
  recent: { family: FamilyId; points: number; source: 'lab' | 'applied'; at: string }[];
}

export interface BrandView {
  id: string;
  name: string;
  logo: number;
  reputation: number;
  designs: number;
  lastDay: { units: number; buyers: number } | null;
  idleDays: number;
}

export interface DesignerResponse {
  rules: { minLength: number; maxLength: number; fee: number; maxPerCompany: number; maxDesignsPerBrand: number; logoCount: number; startingReputation: number };
  brands: BrandView[];
  designs: (ServerDesign & { materials: string[]; stock: number; buildings: string[] })[];
  buildings: { id: string; name: string; typeId: string; designId: string | null }[];
}

export interface ActivityItem {
  id: number;
  kind: string;
  memo: string;
  at: string;
  amountCents: number;
}

export interface MarketRow {
  productId: string;
  name: string;
  tier: string;
  npcVendor: boolean;
  refPriceCents: number;
  lastPriceCents: number;
  change24h: number;
  volume24h: number;
  bestBidCents: number | null;
  bestAskCents: number | null;
}

export interface BookLevel {
  priceCents: number;
  quality: number;
  qty: number;
  orders: number;
}

export interface MarketDetail {
  productId: string;
  book: { bids: BookLevel[]; asks: BookLevel[] };
  history: number[];
  trades: { priceCents: number; qty: number; quality: number; at: string }[];
}

export interface OpenOrder {
  id: string;
  productId: string;
  side: 'buy' | 'sell';
  priceCents: number;
  qty: number;
  remaining: number;
  quality: number;
  createdAt: string;
}

export interface PlaceOrderResult {
  orderId: string;
  status: 'open' | 'filled';
  remaining: number;
  fills: { tradeId: number; qty: number; priceCents: number; quality: number; feeCents: number }[];
}

export interface CollectResult {
  collected: { buildingId: string; productId: string; qty: number; quality: number; researchFamily?: string; restarted: boolean; restartError?: string; xp: number }[];
}

export type LoanStatus = 'active' | 'late' | 'restructure_offered' | 'collections' | 'repaid' | 'defaulted';

export interface ServerLoan {
  id: string;
  product: 'starter' | 'term' | 'overdraft';
  status: LoanStatus;
  principalCents: number;
  dailyRate: number;
  termDays: number;
  installmentCents: number;
  outstandingCents: number;
  arrearsCents: number;
  installmentsDue: number;
  installmentsPaid: number;
  daysPastDue: number;
  restructured: boolean;
  createdDay: number;
}

export interface BankOverview {
  day: number;
  lastSettledDay: number;
  nextCloseAt: string;
  credit: {
    score: number;
    formulaScore: number;
    penalty: number;
    factors: { repayment: number; lowDebt: number; ageDays: number; dscr: number; stability: number };
    tier: { minScore: number; dailyRate: number | null; maxLtv: number; minDscr: number };
    avgDailyOperatingCents: number;
    dailyDebtServiceCents: number;
  };
  offers: {
    starter: { available: boolean; reason?: string; amountCents: number; days: number; dailyRate: number; installmentCents: number };
    term: { available: boolean; reason?: string; maxCents: number; minCents: number; dailyRate: number; minDscr: number; terms: number[] };
  };
  upkeep: { dailyCents: number; arrearsCents: number };
  overdraft: { limitCents: number; dailyRate: number; drawFeeCents: number };
  borrowBlockedUntil: number | null;
  bankruptcies: number;
  loans: ServerLoan[];
  events: { id: number; loanId: string; day: number; kind: string; amountCents: number; note: string }[];
  devTools: boolean;
}

export interface DayReport {
  day: number;
  installmentsPaidCents: number;
  missed: number;
  upkeepPaidCents: number;
  upkeepShortCents: number;
  overdraftDrawCents: number;
  receivership: boolean;
  bankrupt: boolean;
}

export interface ContractDelivery {
  id: string;
  seq: number;
  windowStart: string;
  windowEnd: string;
  valueCents: number;
  status: 'pending' | 'funded' | 'unfunded' | 'settled' | 'breached' | 'cancelled';
  deliveredAt: string | null;
  deliveredQuality: number | null;
  lateHours: number;
  penaltyCents: number;
  feeCents: number;
}

export interface ContractView {
  id: string;
  role: 'buyer' | 'seller';
  counterpartyId: string;
  counterpartyName: string;
  proposedByMe: boolean;
  productId: string;
  qty: number;
  minQuality: number;
  priceCents: number;
  frequencyHours: number;
  windowHours: number;
  termDays: number;
  status: 'offered' | 'rejected' | 'expired' | 'withdrawn' | 'active' | 'completed' | 'terminated_by_notice' | 'terminated_for_breach';
  bondCents: number;
  bondRemainingCents: number;
  offerExpiresAt: string | null;
  acceptedAt: string | null;
  noticeEndsAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  fromRfq: boolean;
  deliveries: ContractDelivery[];
  summary: { total: number; settled: number; onTime: number; open: number };
}

export interface ReliabilityView {
  score: number;
  verified: boolean;
  onTimeCents: number;
  totalCents: number;
  counterparties: number;
}

export interface ContractsResponse {
  reliability: ReliabilityView;
  suspendedUntil: string | null;
  contracts: ContractView[];
}

interface RfqBase {
  id: string;
  productId: string;
  qty: number;
  minQuality: number;
  maxPriceCents: number;
  frequencyHours: number;
  windowHours: number;
  termDays: number;
  minReliability: number;
  closesAt: string;
  status: 'open' | 'awarded' | 'expired' | 'cancelled';
  bids: number;
  contractId: string | null;
}

export interface RfqBoardResponse {
  open: (RfqBase & { buyerName: string; buyerRegion: string; myBidCents: number | null })[];
  mine: (RfqBase & { sealed: boolean; bidList: { id: string; priceCents: number; sellerId: string; sellerName: string; reliability: number }[] })[];
}

export interface Supplier {
  companyId: string;
  name: string;
  region: string;
  isNpc: boolean;
  askCents: number | null;
  qualityRange: string | null;
  delivered: number;
  reliability: number;
  verified: boolean;
}

export interface LeagueRow {
  companyId: string;
  name: string;
  metric: number;
  points: number;
  rank: number;
  eligible: boolean;
  me: boolean;
}

export interface LeagueOverview {
  week: { number: number; startedAt: string; endsAt: string };
  tier: LeagueTier;
  division: { id: string; name: string };
  groupSize: number;
  promoteCount: number;
  relegateCount: number;
  me: { rank: number; points: number; valueAdd: number };
  above: { name: string; rank: number; gap: number } | null;
  below: { name: string; rank: number; gap: number } | null;
  standings: LeagueRow[];
  contests: { id: string; name: string; unit: MetricUnit; metric: number; points: number; rank: number; of: number; eligible: boolean; reason?: string; topReward: string }[];
  empire: { companyId: string; name: string; value: number; rank: number; me: boolean }[];
  history: { week: number; tier: LeagueTier; division: string; rank: number; of: number; points: number; outcome: 'promoted' | 'relegated' | 'stayed'; prizeCents: number }[];
  trophies: { week: number; kind: string; title: string }[];
}

export type LeagueTier = 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond' | 'Master' | 'Tycoon';
export type MetricUnit = 'cr' | 'units' | 'pct' | 'units_per_level';

export interface ContestDetailResponse {
  contest: { id: string; name: string; pitch: string; formula: string; rules: string[]; unit: MetricUnit; rewards: { band: string; prize: string }[] };
  active: boolean;
  week: { number: number; endsAt: string };
  division: string;
  p90: number;
  me: { rank: number; of: number; metric: number; points: number; eligible: boolean; reason?: string; lines: { what: string; why: string; value: string; counted: boolean }[] } | null;
  standings: LeagueRow[];
  lastResult: { week: number; rank: number; points: number; reward: string | null; prizeCents: number } | null;
  rotation: { id: string; name: string; activeThisWeek: boolean }[];
  nextWeek: string[];
}
