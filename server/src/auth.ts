import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db, Tx } from './db';
import { badRequest, GameError } from './errors';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export const AUTH_RULES = {
  passwordMin: 10,
  passwordMax: 200,
  emailMax: 254,
  sessionDays: 30,
  /** Failed sign-ins allowed per window, per email and per client address. */
  maxFailuresPerEmail: 10,
  maxFailuresPerIp: 30,
  failureWindowMs: 15 * 60_000,
} as const;

// scrypt cost: N=2^14, r=8, p=1 (~16 MB, tens of ms per hash).
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash of a random password, verified against when the email is unknown so timing doesn't reveal accounts. */
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function checkCredentials(email: string, password: string) {
  const e = normalizeEmail(email);
  if (e.length > AUTH_RULES.emailMax || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw badRequest('Enter a valid email address.');
  if (password.length < AUTH_RULES.passwordMin) throw new GameError(400, 'weak_password', `Use at least ${AUTH_RULES.passwordMin} characters for your password.`);
  if (password.length > AUTH_RULES.passwordMax) throw new GameError(400, 'weak_password', 'That password is too long.');
  return e;
}

// ---------- Sessions ----------

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Creates a session and returns the bearer token. Only its hash is stored. */
export async function createSession(tx: Pick<Tx, 'query'>, companyId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await tx.query(
    `INSERT INTO sessions (token_hash, company_id, expires_at) VALUES ($1, $2, now() + $3::int * interval '1 day')`,
    [tokenHash(token), companyId, AUTH_RULES.sessionDays],
  );
  return token;
}

export interface SessionCompany {
  id: string;
  name: string;
  region: string;
  level: number;
}

/** Looks up a live session. Sessions slide: each use (at most once a day) pushes expiry 30 days out. */
export async function companyForToken(db: Db, token: string): Promise<SessionCompany | null> {
  const h = tokenHash(token);
  const res = await db.query<SessionCompany>(
    `SELECT c.id, c.name, c.region, c.level FROM sessions s JOIN companies c ON c.id = s.company_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [h],
  );
  if (!res.rows[0]) return null;
  await db.query(
    `UPDATE sessions SET expires_at = now() + $2::int * interval '1 day'
     WHERE token_hash = $1 AND expires_at < now() + ($2::int - 1) * interval '1 day'`,
    [h, AUTH_RULES.sessionDays],
  );
  return res.rows[0];
}

export async function endSession(db: Db, token: string) {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
}

export async function pruneSessions(db: Db) {
  return (await db.query('DELETE FROM sessions WHERE expires_at <= now()')).rowCount ?? 0;
}

// ---------- Sign-in throttling ----------

const failures = new Map<string, { count: number; resetAt: number }>();

function tooMany(key: string, max: number, now: number) {
  const f = failures.get(key);
  return !!f && f.resetAt > now && f.count >= max;
}

function recordFailure(key: string, now: number) {
  const f = failures.get(key);
  if (!f || f.resetAt <= now) failures.set(key, { count: 1, resetAt: now + AUTH_RULES.failureWindowMs });
  else f.count += 1;
}

/** Test hook: forget all recorded failures. */
export const resetThrottle = () => failures.clear();

/**
 * Checks an email and password. Unknown emails and wrong passwords get the same error and similar timing;
 * repeated failures for an email or from one address are refused for 15 minutes.
 */
export async function signIn(db: Db, input: { email: string; password: string; ip: string }): Promise<{ token: string; companyId: string }> {
  const email = normalizeEmail(input.email);
  const now = Date.now();
  if (tooMany(`email:${email}`, AUTH_RULES.maxFailuresPerEmail, now) || tooMany(`ip:${input.ip}`, AUTH_RULES.maxFailuresPerIp, now)) {
    throw new GameError(429, 'too_many_attempts', 'Too many sign-in attempts. Try again in 15 minutes.');
  }
  const user = (await db.query<{ company_id: string; password_hash: string }>(
    'SELECT company_id, password_hash FROM users WHERE lower(email) = $1',
    [email],
  )).rows[0];
  const ok = await verifyPassword(input.password, user?.password_hash ?? (await dummy()));
  if (!user || !ok) {
    recordFailure(`email:${email}`, now);
    recordFailure(`ip:${input.ip}`, now);
    throw new GameError(401, 'bad_credentials', 'Email or password is incorrect.');
  }
  failures.delete(`email:${email}`);
  return { token: await createSession(db, user.company_id), companyId: user.company_id };
}
