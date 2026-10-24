import { levelForXp, levelProgress, nextUnlock } from '../../shared/levels';
import type { Tx } from './db';
import { gameDay } from './time';

type Q = Pick<Tx, 'query'>;

export type XpSource = 'production' | 'contract_sale' | 'contract_purchase' | 'trade' | 'npc_sale';

export interface XpAward {
  awarded: number;
  levelBefore: number;
  levelAfter: number;
}

/**
 * Adds XP to a company, respecting an optional per-game-day cap for `capKey`, and raises its level
 * when it crosses a threshold. Levels never go down. NPC companies don't earn XP.
 */
export async function awardXp(
  tx: Tx,
  companyId: string,
  source: XpSource,
  rawAmount: number,
  opts: { note?: string; capKey?: string; dailyCap?: number; now?: Date } = {},
): Promise<XpAward> {
  const c = (await tx.query<{ xp: number; level: number; is_npc: boolean }>('SELECT xp, level, is_npc FROM companies WHERE id = $1 FOR UPDATE', [companyId])).rows[0];
  const none = { awarded: 0, levelBefore: c.level, levelAfter: c.level };
  let amount = Math.floor(rawAmount);
  if (c.is_npc || amount <= 0) return none;

  const day = gameDay(opts.now?.getTime());
  if (opts.capKey && opts.dailyCap !== undefined) {
    const used = await tx.query<{ n: number }>(
      'SELECT COALESCE(SUM(amount), 0)::int AS n FROM xp_events WHERE company_id = $1 AND day = $2 AND cap_key = $3',
      [companyId, day, opts.capKey],
    );
    amount = Math.min(amount, opts.dailyCap - used.rows[0].n);
    if (amount <= 0) return none;
  }

  const xp = Number(c.xp) + amount;
  const level = Math.max(c.level, levelForXp(xp));
  await tx.query(
    'INSERT INTO xp_events (company_id, day, source, cap_key, amount, note) VALUES ($1, $2, $3, $4, $5, $6)',
    [companyId, day, source, opts.capKey ?? null, amount, opts.note ?? ''],
  );
  await tx.query('UPDATE companies SET xp = $2, level = $3 WHERE id = $1', [companyId, xp, level]);
  return { awarded: amount, levelBefore: c.level, levelAfter: level };
}

/** XP summary for the client: progress inside the level, the next unlock and recent awards. */
export async function xpSummary(q: Q, companyId: string) {
  const c = (await q.query<{ xp: number; level: number }>('SELECT xp, level FROM companies WHERE id = $1', [companyId])).rows[0];
  const recent = await q.query<{ amount: number; source: string; note: string; created_at: Date }>(
    'SELECT amount, source, note, created_at FROM xp_events WHERE company_id = $1 ORDER BY id DESC LIMIT 5',
    [companyId],
  );
  const xp = Number(c.xp);
  const progress = levelProgress(xp, c.level);
  return {
    total: xp,
    level: c.level,
    intoLevel: progress.intoLevel,
    levelSize: progress.levelSize,
    nextLevelAt: progress.nextLevelAt,
    nextUnlock: nextUnlock(c.level),
    recent: recent.rows.map((r) => ({ amount: r.amount, source: r.source, note: r.note, at: r.created_at.toISOString() })),
  };
}
