import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { hashPassword, pruneSessions, resetThrottle, verifyPassword } from '../src/auth';
import type { Db } from '../src/db';
import { freshDb } from './helpers';

let db: Db;
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  db = await freshDb();
  app = buildApp(db);
});
afterAll(async () => {
  await app.close();
  await db.end();
});
beforeEach(() => resetThrottle());

const PASSWORD = 'a long enough password';
const signup = (email: string, companyName: string, password = PASSWORD) =>
  app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password, companyName } });
const signin = (email: string, password: string) => app.inject({ method: 'POST', url: '/api/auth/signin', payload: { email, password } });
const me = (token: string) => app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });

describe('passwords', () => {
  it('hashes with a random salt and verifies only the right password', async () => {
    const a = await hashPassword('hunter2hunter2');
    const b = await hashPassword('hunter2hunter2');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(await verifyPassword('hunter2hunter2', a)).toBe(true);
    expect(await verifyPassword('hunter2hunter3', a)).toBe(false);
  });
});

describe('accounts', () => {
  it('signs up with a company, signs in again, and signs out', async () => {
    const res = await signup('Founder@Example.com', 'Founders Mill');
    expect(res.statusCode).toBe(201);
    const { token } = res.json();
    expect((await me(token)).json().account).toEqual({ email: 'founder@example.com' });

    const again = await signin('  founder@EXAMPLE.com ', PASSWORD);
    expect(again.statusCode).toBe(200);
    const second = again.json().token;
    expect(second).not.toBe(token);
    expect((await me(second)).json().company.name).toBe('Founders Mill');

    await app.inject({ method: 'POST', url: '/api/auth/signout', headers: { authorization: `Bearer ${second}` } });
    expect((await me(second)).statusCode).toBe(401);
    expect((await me(token)).statusCode).toBe(200); // other sessions stay signed in
  });

  it('validates email, password length and uniqueness', async () => {
    expect((await signup('not-an-email', 'Bad Email Co')).json().error.message).toMatch(/valid email/);
    expect((await signup('short@example.com', 'Short Pw Co', 'tooshort')).json().error.code).toBe('weak_password');
    await signup('taken@example.com', 'Taken One');
    const dupe = await signup('TAKEN@example.com', 'Taken Two');
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.code).toBe('email_taken');
    // The failed sign-up left no half-made company behind.
    expect((await db.query("SELECT 1 FROM companies WHERE name = 'Taken Two'")).rowCount).toBe(0);
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    await signup('real@example.com', 'Real Co');
    const wrong = await signin('real@example.com', 'not the password');
    const unknown = await signin('nobody@example.com', 'not the password');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('refuses sign-in for 15 minutes after 10 failures for an email', async () => {
    await signup('target@example.com', 'Target Co');
    for (let i = 0; i < 10; i++) expect((await signin('target@example.com', `guess number ${i}`)).statusCode).toBe(401);
    const blocked = await signin('target@example.com', PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('too_many_attempts');
  });

  it('stores only token hashes and expires sessions', async () => {
    const { token } = (await signup('expiry@example.com', 'Expiry Co')).json();
    const raw = await db.query('SELECT 1 FROM sessions WHERE token_hash = $1', [token]);
    expect(raw.rowCount).toBe(0);
    await db.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE company_id = (SELECT company_id FROM users WHERE email = 'expiry@example.com')");
    expect((await me(token)).statusCode).toBe(401);
    expect(await pruneSessions(db)).toBeGreaterThan(0);
  });
});
