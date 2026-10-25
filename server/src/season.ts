import { WEEK_DAYS } from '../../shared/leagues';
import { RESEARCH_PRODUCT } from '../../shared/research';
import { rewardLabel, SEASON_DAYS, SEASON_TIERS, seasonName, seasonTier, tierReward, XP_PER_TIER } from '../../shared/season';
import type { Db, Tx } from './db';
import { badRequest, conflict, notFound } from './errors';
import { addGoods } from './inventory';
import { companyAccount, systemAccount, toCents, transfer } from './ledger';
import { gameDay } from './time';

type Q = Pick<Tx, 'query'>;

export interface SeasonInfo {
  /** Season number shown to players (1 = the season of the first league week). */
  number: number;
  name: string;
  startDay: number;
  endDay: number;
  daysLeft: number;
}

/** The season containing `day`. Seasons are 28 game days, aligned with league weeks. */
export async function seasonAt(q: Q, day = gameDay()): Promise<SeasonInfo> {
  const index = Math.floor(day / SEASON_DAYS);
  const first = (await q.query<{ w: number | null }>('SELECT MIN(week) AS w FROM league_weeks')).rows[0].w;
  const firstIndex = first === null ? index : Math.floor((first * WEEK_DAYS) / SEASON_DAYS);
  const number = Math.max(1, index - firstIndex + 1);
  const startDay = index * SEASON_DAYS;
  return { number, name: seasonName(number), startDay, endDay: startDay + SEASON_DAYS, daysLeft: startDay + SEASON_DAYS - day };
}

/** XP earned between the season's first and last day (seed grants don't count). */
export async function seasonXp(q: Q, companyId: string, s: SeasonInfo): Promise<number> {
  const res = await q.query<{ xp: number }>(
    `SELECT COALESCE(SUM(amount), 0)::int AS xp FROM xp_events
     WHERE company_id = $1 AND day >= $2::int AND day < $3::int AND source <> 'seed'`,
    [companyId, s.startDay, s.endDay],
  );
  return res.rows[0].xp;
}

async function claimedTiers(q: Q, companyId: string, season: number): Promise<Set<number>> {
  const res = await q.query<{ tier: number }>('SELECT tier FROM season_claims WHERE company_id = $1 AND season = $2', [companyId, season]);
  return new Set(res.rows.map((r) => r.tier));
}

/** Grants one reached, unclaimed tier of the current season. */
export async function claimTier(tx: Tx, companyId: string, tier: number) {
  if (!Number.isInteger(tier) || tier < 1 || tier > SEASON_TIERS) throw badRequest('Unknown tier.');
  await tx.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  const s = await seasonAt(tx);
  const reached = seasonTier(await seasonXp(tx, companyId, s));
  if (tier > reached) throw conflict('not_reached', `Reach tier ${tier} first (${(tier * XP_PER_TIER).toLocaleString('en-US')} season XP).`);
  const ins = await tx.query('INSERT INTO season_claims (company_id, season, tier) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [companyId, s.number, tier]);
  if (!ins.rowCount) throw conflict('claimed', 'Already claimed.');

  const reward = tierReward(s.number, tier);
  switch (reward.kind) {
    case 'wallet':
      await transfer(tx, 'season_reward', `${s.name} tier ${tier}`, await systemAccount(tx, 'faucet:season_rewards'), await companyAccount(tx, companyId, 'wallet'), toCents(reward.amount));
      break;
    case 'research':
      await addGoods(tx, companyId, RESEARCH_PRODUCT, 0, reward.amount);
      break;
    case 'livery':
    case 'title':
      await tx.query('INSERT INTO cosmetics (company_id, kind, name, season) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [companyId, reward.kind, reward.name, s.number]);
      break;
    case 'trophy':
      await tx.query("INSERT INTO trophies (company_id, week, kind, title) VALUES ($1, $2, 'season', $3)", [companyId, s.number, `${reward.name} · Season ${s.number}`]);
      break;
  }
  return { tier, reward, label: rewardLabel(reward) };
}

/** Claims every reached tier not yet claimed this season. */
export async function claimAll(tx: Tx, companyId: string) {
  const s = await seasonAt(tx);
  const reached = seasonTier(await seasonXp(tx, companyId, s));
  const claimed = await claimedTiers(tx, companyId, s.number);
  const out = [];
  for (let t = 1; t <= reached; t++) if (!claimed.has(t)) out.push(await claimTier(tx, companyId, t));
  return { claimed: out };
}

/** Equips an unlocked title (shown under the company name), or clears it. */
export async function setTitle(tx: Tx, companyId: string, name: string | null) {
  if (name !== null) {
    const owned = await tx.query("SELECT 1 FROM cosmetics WHERE company_id = $1 AND kind = 'title' AND name = $2", [companyId, name]);
    if (!owned.rowCount) throw notFound('Title');
  }
  await tx.query('UPDATE companies SET title = $2 WHERE id = $1', [companyId, name]);
  return { title: name };
}

/** Compact season status for /api/me (sidebar box). */
export async function seasonSummary(q: Q, companyId: string) {
  const s = await seasonAt(q);
  const xp = await seasonXp(q, companyId, s);
  const tier = seasonTier(xp);
  const claimed = await claimedTiers(q, companyId, s.number);
  const next = tier < SEASON_TIERS ? tierReward(s.number, tier + 1) : null;
  const title = (await q.query<{ title: string | null }>('SELECT title FROM companies WHERE id = $1', [companyId])).rows[0].title;
  return {
    number: s.number,
    name: s.name,
    daysLeft: s.daysLeft,
    xp,
    tier,
    tiers: SEASON_TIERS,
    xpPerTier: XP_PER_TIER,
    unclaimed: Array.from({ length: tier }, (_, i) => i + 1).filter((t) => !claimed.has(t)).length,
    next: next ? rewardLabel(next) : null,
    title,
  };
}

export async function seasonView(db: Db, companyId: string) {
  const summary = await seasonSummary(db, companyId);
  const claimed = await claimedTiers(db, companyId, summary.number);
  const cosmetics = await db.query<{ kind: 'livery' | 'title'; name: string; season: number }>(
    'SELECT kind, name, season FROM cosmetics WHERE company_id = $1 ORDER BY unlocked_at',
    [companyId],
  );
  return {
    ...summary,
    rewards: Array.from({ length: SEASON_TIERS }, (_, i) => {
      const tier = i + 1;
      const reward = tierReward(summary.number, tier);
      return { tier, reward, label: rewardLabel(reward), reached: tier <= summary.tier, claimed: claimed.has(tier) };
    }),
    cosmetics: cosmetics.rows,
  };
}
