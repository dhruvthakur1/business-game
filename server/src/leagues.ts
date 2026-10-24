import {
  baselineP90,
  CHECKPOINT_POINTS,
  contestById,
  contestPoints,
  CONTESTS,
  DIVISIONS,
  divisionFor,
  GROUP_SIZE,
  prizeCap,
  promoteCount,
  relegateCount,
  TIERS,
  WEEK_DAYS,
  weeklyContests,
  type ContestId,
  type Division,
  type Tier,
} from '../../shared/leagues';
import { computeMetric, type MetricResult } from './contestMetrics';
import { type Db, type Tx, withTx } from './db';
import { notFound } from './errors';
import { companyAccount, systemAccount, toCents, transfer } from './ledger';
import { assetsCents, debtCents, operatingFlowCents } from './state';
import { gameDay, gameDayStart } from './time';

type Q = Pick<Tx, 'query'>;

export interface WeekRow {
  week: number;
  started_at: Date;
  ends_at: Date;
  closed_at: Date | null;
  status: 'active' | 'closed';
  contests: ContestId[];
}

interface MemberRow {
  week: number;
  company_id: string;
  group_id: string;
  division: Division['id'];
  tier: Tier;
  start_net_worth_cents: number;
  joined_at: Date;
}

const divisionById = (id: string) => DIVISIONS.find((d) => d.id === id) ?? DIVISIONS[0];

/** Week numbers are game weeks since 1970; players see them counted from the server's first league week. */
export async function weekLabel(q: Q, week: number): Promise<number> {
  const first = (await q.query<{ w: number | null }>('SELECT MIN(week) AS w FROM league_weeks')).rows[0].w;
  return first === null ? 1 : week - first + 1;
}
const clockWeek = (now: number) => Math.floor(gameDay(now) / WEEK_DAYS);

// ---------------------------------------------------------------- weeks & membership

export async function activeWeek(q: Q): Promise<WeekRow | null> {
  return (await q.query<WeekRow>("SELECT * FROM league_weeks WHERE status = 'active' ORDER BY week DESC LIMIT 1")).rows[0] ?? null;
}

/** Starts a new week if none is active. It ends at the next game-week boundary. */
export async function ensureWeek(db: Db, now = new Date()): Promise<WeekRow> {
  const existing = await activeWeek(db);
  if (existing) return existing;
  const last = (await db.query<{ week: number }>('SELECT MAX(week) AS week FROM league_weeks')).rows[0].week;
  const clock = clockWeek(now.getTime());
  const week = Math.max(clock, last === null ? clock : last + 1);
  const endsAt = gameDayStart((clock + 1) * WEEK_DAYS);
  await db.query(
    'INSERT INTO league_weeks (week, started_at, ends_at, contests) VALUES ($1, $2, $3, $4) ON CONFLICT (week) DO NOTHING',
    [week, now, endsAt, weeklyContests(week)],
  );
  return (await activeWeek(db))!;
}

/** Places a company into a group of up to 30 in its division (by net worth) and tier. NPCs don't play. */
export async function ensureMember(tx: Tx, companyId: string, week: number): Promise<MemberRow | null> {
  const existing = await tx.query<MemberRow>('SELECT * FROM league_members WHERE week = $1 AND company_id = $2', [week, companyId]);
  if (existing.rows[0]) return existing.rows[0];
  const c = (await tx.query<{ is_npc: boolean; league_tier: Tier }>('SELECT is_npc, league_tier FROM companies WHERE id = $1', [companyId])).rows[0];
  if (!c || c.is_npc) return null;
  const nw = (await assetsCents(tx, companyId)) - (await debtCents(tx, companyId));
  const division = divisionFor(nw / 100);
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`league:${week}:${division.id}:${c.league_tier}`]);
  let group = (await tx.query<{ id: string }>(
    `SELECT g.id FROM league_groups g WHERE g.week = $1 AND g.division = $2 AND g.tier = $3
       AND (SELECT COUNT(*) FROM league_members m WHERE m.group_id = g.id) < $4
     ORDER BY g.group_no LIMIT 1`,
    [week, division.id, c.league_tier, GROUP_SIZE],
  )).rows[0];
  if (!group) {
    group = (await tx.query<{ id: string }>(
      `INSERT INTO league_groups (week, division, tier, group_no)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(group_no), 0) + 1 FROM league_groups WHERE week = $1 AND division = $2 AND tier = $3)) RETURNING id`,
      [week, division.id, c.league_tier],
    )).rows[0];
  }
  return (await tx.query<MemberRow>(
    `INSERT INTO league_members (week, company_id, group_id, division, tier, start_net_worth_cents) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING RETURNING *`,
    [week, companyId, group.id, division.id, c.league_tier, nw],
  )).rows[0] ?? (await tx.query<MemberRow>('SELECT * FROM league_members WHERE week = $1 AND company_id = $2', [week, companyId])).rows[0];
}

async function ensureAllMembers(db: Db, week: number) {
  const missing = await db.query<{ id: string }>(
    'SELECT id FROM companies c WHERE NOT is_npc AND NOT EXISTS (SELECT 1 FROM league_members m WHERE m.week = $1 AND m.company_id = c.id)',
    [week],
  );
  for (const c of missing.rows) await withTx(db, (tx) => ensureMember(tx, c.id, week));
}

// ---------------------------------------------------------------- scoring

/** Last closed week's 90th percentile of a contest metric in a division, or the baseline if there isn't enough data. */
export async function p90For(q: Q, contest: ContestId, division: Division, beforeWeek: number): Promise<number> {
  const def = contestById(contest)!;
  const res = contest === 'industry'
    ? await q.query<{ p90: number | null; n: number }>(
        `SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY value_add_cents / 100.0) AS p90, COUNT(*)::int AS n
         FROM league_members WHERE division = $1 AND value_add_cents > 0
           AND week = (SELECT MAX(week) FROM league_weeks WHERE status = 'closed' AND week < $2)`,
        [division.id, beforeWeek],
      )
    : await q.query<{ p90: number | null; n: number }>(
        `SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY metric) AS p90, COUNT(*)::int AS n
         FROM contest_results WHERE contest_id = $1 AND division = $2 AND metric > 0 AND eligible
           AND week = (SELECT MAX(week) FROM contest_results WHERE contest_id = $1 AND week < $3)`,
        [contest, division.id, beforeWeek],
      );
  const r = res.rows[0];
  return r && r.n >= 5 && r.p90 ? Number(r.p90) : baselineP90(def, division);
}

export interface Standing {
  companyId: string;
  name: string;
  metric: number;
  points: number;
  rank: number;
  eligible: boolean;
  reason?: string;
  result?: MetricResult;
}

const windowOf = (w: WeekRow, now: Date) => ({ from: w.started_at, to: w.status === 'closed' ? (w.closed_at ?? w.ends_at) : new Date(Math.min(now.getTime(), w.ends_at.getTime())) });

/** Live (or final) standings of one group in one contest. Ineligible entries rank below eligible ones with 0 points. */
export async function groupStandings(q: Q, w: WeekRow, groupId: string, contest: ContestId, now = new Date()): Promise<Standing[]> {
  const members = await q.query<MemberRow & { name: string }>(
    'SELECT m.*, c.name FROM league_members m JOIN companies c ON c.id = m.company_id WHERE m.group_id = $1 ORDER BY m.joined_at',
    [groupId],
  );
  if (!members.rows.length) return [];
  const division = divisionById(members.rows[0].division);
  const p90 = await p90For(q, contest, division, w.week);
  const { from, to } = windowOf(w, now);
  const rows: Standing[] = [];
  for (const m of members.rows) {
    const result = await computeMetric(q, contest, { companyId: m.company_id, from, to, division, startNetWorthCents: Number(m.start_net_worth_cents) });
    rows.push({
      companyId: m.company_id,
      name: m.name,
      metric: result.metric,
      points: result.eligible ? contestPoints(result.metric, p90) : 0,
      rank: 0,
      eligible: result.eligible,
      reason: result.reason,
      result,
    });
  }
  rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.points - a.points || b.metric - a.metric);
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

// ---------------------------------------------------------------- week close

async function payPrize(tx: Tx, companyId: string, cents: number, memo: string) {
  if (cents <= 0) return 0;
  await transfer(tx, 'contest_prize', memo, await systemAccount(tx, 'faucet:contest_prizes'), await companyAccount(tx, companyId, 'cash'), cents);
  return cents;
}

const tierStep = (tier: Tier, step: number) => TIERS[Math.min(TIERS.length - 1, Math.max(0, TIERS.indexOf(tier) + step))];

/**
 * Closes a week: final Industry League ranks → promotion (top 7 of 30, needs > 0 points) and relegation
 * (bottom 5 of 30); contest results per group with cosmetic rewards and a capped CR prize for each #1;
 * trophies for promotions and wins. Runs in one transaction so a week closes exactly once.
 */
export async function closeWeek(db: Db, weekNo: number, now = new Date()) {
  return withTx(db, async (tx) => {
    const w = (await tx.query<WeekRow>('SELECT * FROM league_weeks WHERE week = $1 FOR UPDATE', [weekNo])).rows[0];
    if (!w || w.status !== 'active') return { closed: false };
    const closedAt = new Date(Math.min(now.getTime(), w.ends_at.getTime()));
    w.closed_at = closedAt;
    const label = await weekLabel(tx, weekNo);

    // Operating cash flow per member → division median → prize cap.
    const members = await tx.query<MemberRow>('SELECT * FROM league_members WHERE week = $1', [weekNo]);
    const flows = new Map<string, number>();
    for (const m of members.rows) {
      const flow = await operatingFlowCents(tx, m.company_id, w.started_at, closedAt);
      flows.set(m.company_id, flow);
      await tx.query('UPDATE league_members SET op_flow_cents = $3 WHERE week = $1 AND company_id = $2', [weekNo, m.company_id, flow]);
    }
    const capByDivision = new Map<string, number>();
    for (const d of DIVISIONS) {
      const xs = members.rows.filter((m) => m.division === d.id).map((m) => flows.get(m.company_id)! / 100).sort((a, b) => a - b);
      const median = xs.length ? xs[Math.floor(xs.length / 2)] : 0;
      capByDivision.set(d.id, toCents(prizeCap(d, median)));
    }

    const groups = await tx.query<{ id: string; division: string; tier: Tier }>('SELECT id, division, tier FROM league_groups WHERE week = $1', [weekNo]);
    let promoted = 0;
    let relegated = 0;
    for (const g of groups.rows) {
      const cap = capByDivision.get(g.division) ?? 0;
      const industry = await groupStandings(tx, { ...w, status: 'closed' }, g.id, 'industry', closedAt);
      const n = industry.length;
      const up = g.tier === 'Tycoon' ? 0 : promoteCount(n);
      const down = g.tier === 'Bronze' ? 0 : relegateCount(n);
      for (const s of industry) {
        const outcome = s.rank <= up && s.points > 0 ? 'promoted' : s.rank > n - down ? 'relegated' : 'stayed';
        const prize = s.rank === 1 && s.points > 0 ? await payPrize(tx, s.companyId, cap, `Industry League #1 · week ${label}`) : 0;
        await tx.query(
          `UPDATE league_members SET value_add_cents = $3, points = $4, final_rank = $5, outcome = $6, prize_cents = $7
           WHERE week = $1 AND company_id = $2`,
          [weekNo, s.companyId, Math.round(s.metric * 100), s.points, s.rank, outcome, prize],
        );
        if (outcome !== 'stayed') {
          const next = tierStep(g.tier, outcome === 'promoted' ? 1 : -1);
          await tx.query('UPDATE companies SET league_tier = $2 WHERE id = $1', [s.companyId, next]);
          await tx.query('INSERT INTO trophies (company_id, week, kind, title) VALUES ($1, $2, $3, $4)', [s.companyId, weekNo, outcome === 'promoted' ? 'promotion' : 'relegation', `${g.tier} → ${next} · W${label}`]);
          if (outcome === 'promoted') promoted += 1;
          else relegated += 1;
        }
      }

      for (const contest of w.contests) {
        const def = contestById(contest)!;
        const standings = await groupStandings(tx, { ...w, status: 'closed' }, g.id, contest, closedAt);
        for (const s of standings) {
          let reward: string | null = null;
          let prize = 0;
          if (s.eligible && s.points > 0) {
            const band = s.rank === 1 ? def.rewards[0] : s.rank <= 3 ? def.rewards.find((r) => r.band === 'Top 3') : s.rank <= 10 ? def.rewards.find((r) => r.band === 'Top 10') : undefined;
            if (band) reward = band.prize.replace(' + capped CR', '');
            else if (s.points >= CHECKPOINT_POINTS) reward = 'Checkpoint cosmetic';
            if (s.rank === 1) prize = await payPrize(tx, s.companyId, cap, `${def.name} #1 · week ${label}`);
            if (reward) {
              await tx.query('INSERT INTO trophies (company_id, week, kind, title) VALUES ($1, $2, $3, $4)', [
                s.companyId, weekNo, reward === 'Checkpoint cosmetic' ? 'checkpoint' : 'contest', `${def.name} #${s.rank} · W${label}: ${reward}`,
              ]);
            }
          }
          await tx.query(
            `INSERT INTO contest_results (week, contest_id, company_id, group_id, division, metric, points, rank, eligible, reward, prize_cents)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [weekNo, contest, s.companyId, g.id, g.division, s.metric, s.points, s.rank, s.eligible, reward, prize],
          );
        }
      }
    }
    await tx.query("UPDATE league_weeks SET status = 'closed', closed_at = $2 WHERE week = $1", [weekNo, closedAt]);
    return { closed: true, promoted, relegated };
  });
}

/** Scheduler pass: close finished weeks, open the next one and seat every company. */
export async function runLeagueCycle(db: Db, now = new Date()) {
  const due = await db.query<{ week: number }>("SELECT week FROM league_weeks WHERE status = 'active' AND ends_at <= $1 ORDER BY week", [now]);
  for (const d of due.rows) await closeWeek(db, d.week, now);
  const w = await ensureWeek(db, now);
  await ensureAllMembers(db, w.week);
  return w;
}

// ---------------------------------------------------------------- read models

/** Short summary for /api/me: tier, division and live Industry League rank. */
export async function leagueSummary(db: Db, companyId: string) {
  const w = await activeWeek(db);
  if (!w) return null;
  const m = (await db.query<MemberRow>('SELECT * FROM league_members WHERE week = $1 AND company_id = $2', [w.week, companyId])).rows[0];
  if (!m) return null;
  const size = (await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM league_members WHERE group_id = $1', [m.group_id])).rows[0].n;
  // Rank by value added so far (the Industry League metric), without computing other contests.
  const rank = await db.query<{ r: number }>(
    `WITH va AS (
       SELECT m.company_id, COALESCE((SELECT SUM(j.value_add_cents) FROM production_jobs j JOIN buildings b ON b.id = j.building_id
         WHERE b.company_id = m.company_id AND j.state = 'collected' AND j.collected_at >= $2), 0) AS v, m.joined_at
       FROM league_members m WHERE m.group_id = $1)
     SELECT r FROM (SELECT company_id, ROW_NUMBER() OVER (ORDER BY v DESC, joined_at) AS r FROM va) x WHERE company_id = $3`,
    [m.group_id, w.started_at, companyId],
  );
  return { week: await weekLabel(db, w.week), endsAt: w.ends_at.toISOString(), tier: m.tier, division: divisionById(m.division).name, rank: Number(rank.rows[0]?.r ?? 1), groupSize: size };
}

const MEMBER_FIELDS = (s: Standing, me: string) => ({ companyId: s.companyId, name: s.name, metric: s.metric, points: s.points, rank: s.rank, eligible: s.eligible, me: s.companyId === me });

export async function leagueOverview(db: Db, companyId: string, now = new Date()) {
  const w = await ensureWeek(db, now);
  const m = await withTx(db, (tx) => ensureMember(tx, companyId, w.week));
  if (!m) throw notFound('League membership');
  const division = divisionById(m.division);
  const standings = await groupStandings(db, w, m.group_id, 'industry', now);
  const me = standings.find((s) => s.companyId === companyId)!;
  const above = standings.find((s) => s.rank === me.rank - 1);
  const below = standings.find((s) => s.rank === me.rank + 1);
  const n = standings.length;

  const contests = [];
  for (const id of w.contests) {
    const rows = await groupStandings(db, w, m.group_id, id, now);
    const mine = rows.find((r) => r.companyId === companyId)!;
    const def = contestById(id)!;
    contests.push({ id, name: def.name, unit: def.unit, metric: mine.metric, points: mine.points, rank: mine.rank, of: rows.length, eligible: mine.eligible, reason: mine.reason, topReward: def.rewards[0].prize });
  }

  // Empire value: every player company by conservative net worth, around me.
  const companies = await db.query<{ id: string; name: string }>('SELECT id, name FROM companies WHERE NOT is_npc');
  const worth = [];
  for (const c of companies.rows) worth.push({ companyId: c.id, name: c.name, value: ((await assetsCents(db, c.id)) - (await debtCents(db, c.id))) / 100 });
  worth.sort((a, b) => b.value - a.value);
  const myIdx = worth.findIndex((x) => x.companyId === companyId);
  const empire = worth.map((x, i) => ({ ...x, rank: i + 1, me: x.companyId === companyId })).slice(Math.max(0, myIdx - 3), myIdx + 4);

  const history = await db.query(
    `SELECT m.week, m.tier, m.division, m.final_rank, m.points, m.outcome, m.prize_cents,
            (SELECT COUNT(*)::int FROM league_members x WHERE x.group_id = m.group_id) AS size
     FROM league_members m WHERE m.company_id = $1 AND m.outcome IS NOT NULL ORDER BY m.week DESC LIMIT 6`,
    [companyId],
  );
  const trophies = await db.query('SELECT week, kind, title FROM trophies WHERE company_id = $1 ORDER BY id DESC LIMIT 12', [companyId]);

  return {
    week: { number: await weekLabel(db, w.week), startedAt: w.started_at.toISOString(), endsAt: w.ends_at.toISOString() },
    tier: m.tier,
    division: { id: division.id, name: division.name },
    groupSize: n,
    promoteCount: m.tier === 'Tycoon' ? 0 : promoteCount(n),
    relegateCount: m.tier === 'Bronze' ? 0 : relegateCount(n),
    me: { rank: me.rank, points: me.points, valueAdd: me.metric },
    above: above ? { name: above.name, rank: above.rank, gap: above.metric - me.metric } : null,
    below: below ? { name: below.name, rank: below.rank, gap: me.metric - below.metric } : null,
    standings: standings.map((s) => MEMBER_FIELDS(s, companyId)),
    contests,
    empire,
    history: await Promise.all(history.rows.map(async (h) => ({ week: await weekLabel(db, h.week), tier: h.tier, division: divisionById(h.division).name, rank: h.final_rank, of: h.size, points: h.points, outcome: h.outcome, prizeCents: Number(h.prize_cents) }))),
    trophies: await Promise.all(trophies.rows.map(async (t) => ({ ...t, week: await weekLabel(db, t.week) }))),
  };
}

export async function contestDetail(db: Db, companyId: string, contestId: string, now = new Date()) {
  const def = contestById(contestId);
  if (!def) throw notFound('Contest');
  const w = await ensureWeek(db, now);
  const m = await withTx(db, (tx) => ensureMember(tx, companyId, w.week));
  if (!m) throw notFound('League membership');
  const division = divisionById(m.division);
  const active = def.id === 'industry' || w.contests.includes(def.id);
  const rows = active ? await groupStandings(db, w, m.group_id, def.id, now) : [];
  const mine = rows.find((r) => r.companyId === companyId);
  const last = await db.query(
    'SELECT week, rank, points, metric, reward, prize_cents FROM contest_results WHERE company_id = $1 AND contest_id = $2 ORDER BY week DESC LIMIT 1',
    [companyId, def.id],
  );
  return {
    contest: def,
    active,
    week: { number: await weekLabel(db, w.week), endsAt: w.ends_at.toISOString() },
    division: division.name,
    p90: await p90For(db, def.id, division, w.week),
    me: mine ? { rank: mine.rank, of: rows.length, metric: mine.metric, points: mine.points, eligible: mine.eligible, reason: mine.reason, lines: mine.result?.lines ?? [] } : null,
    standings: rows.slice(0, 10).map((s) => MEMBER_FIELDS(s, companyId)).concat(mine && mine.rank > 10 ? [MEMBER_FIELDS(mine, companyId)] : []),
    lastResult: last.rows[0] ? { week: await weekLabel(db, last.rows[0].week), rank: last.rows[0].rank, points: last.rows[0].points, reward: last.rows[0].reward, prizeCents: Number(last.rows[0].prize_cents) } : null,
    rotation: CONTESTS.filter((c) => c.id !== 'industry').map((c) => ({ id: c.id, name: c.name, activeThisWeek: w.contests.includes(c.id) })),
    nextWeek: weeklyContests(w.week + 1).map((id) => contestById(id)!.name),
  };
}
