import { randomBytes } from 'node:crypto';
import { STARTING_CAPITAL } from '../../shared/catalog';
import type { Db, Tx } from './db';
import { withTx } from './db';
import { badRequest, conflict } from './errors';
import { companyAccount, systemAccount, toCents, transfer } from './ledger';
import { gameDay } from './time';
import { xpForLevel } from '../../shared/levels';

export interface Company {
  id: string;
  name: string;
  region: string;
  level: number;
}

export const REGIONS = ['north', 'east', 'south', 'west'] as const;

export async function createCompany(
  db: Db,
  input: { name: string; region?: string; isNpc?: boolean; capitalCents?: number; level?: number },
): Promise<{ company: Company; token: string }> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 28) throw badRequest('Company name must be 3–28 characters.');
  const region = input.region ?? 'north';
  if (!REGIONS.includes(region as (typeof REGIONS)[number])) throw badRequest('Unknown region.');

  return withTx(db, async (tx) => {
    let company: Company;
    try {
      const res = await tx.query<Company>(
        `INSERT INTO companies (name, region, is_npc, level, xp, created_day, last_settled_day)
         VALUES ($1, $2, $3, $4, $5, $6, $6 - 1) RETURNING id, name, region, level`,
        [name, region, input.isNpc ?? false, input.level ?? 1, xpForLevel(input.level ?? 1), gameDay()],
      );
      company = res.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('name_taken', 'That company name is taken.');
      throw err;
    }
    await tx.query("INSERT INTO accounts (company_id, kind) VALUES ($1, 'cash'), ($1, 'escrow'), ($1, 'bond'), ($1, 'wallet')", [company.id]);
    const capital = input.capitalCents ?? toCents(STARTING_CAPITAL);
    const faucet = await systemAccount(tx, 'faucet:starting_capital');
    const cash = await companyAccount(tx, company.id, 'cash');
    await transfer(tx, 'starting_capital', 'Welcome capital', faucet, cash, capital, `start:${company.id}`);
    const token = await createSession(tx, company.id);
    return { company, token };
  });
}

export async function createSession(tx: Tx, companyId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await tx.query('INSERT INTO sessions (token, company_id) VALUES ($1, $2)', [token, companyId]);
  return token;
}

export async function companyForToken(db: Db, token: string): Promise<Company | null> {
  const res = await db.query<Company>(
    'SELECT c.id, c.name, c.region, c.level FROM sessions s JOIN companies c ON c.id = s.company_id WHERE s.token = $1',
    [token],
  );
  return res.rows[0] ?? null;
}
