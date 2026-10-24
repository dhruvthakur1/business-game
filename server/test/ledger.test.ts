import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db, withTx } from '../src/db';
import { GameError } from '../src/errors';
import { companyAccount, post, systemAccount, transfer } from '../src/ledger';
import { cash, freshDb, ledgerTotal, newCompany } from './helpers';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

describe('ledger', () => {
  it('credits starting capital through a balanced transaction', async () => {
    const c = await newCompany(db, { capital: 123_45 });
    expect(await cash(db, c.id)).toBe(123_45);
    expect(await ledgerTotal(db)).toEqual({ balances: 0, entries: 0 });
  });

  it('rejects unbalanced posts', async () => {
    const c = await newCompany(db);
    await expect(
      withTx(db, async (tx) => {
        const acct = await companyAccount(tx, c.id, 'cash');
        await post(tx, { kind: 'op_cost', memo: 'bad', entries: [{ accountId: acct, amount: -100 }] });
      }),
    ).rejects.toThrow(/Unbalanced/);
  });

  it('never lets a company balance go negative', async () => {
    const c = await newCompany(db, { capital: 1000 });
    const err = await withTx(db, async (tx) => {
      const from = await companyAccount(tx, c.id, 'cash');
      const to = await systemAccount(tx, 'sink:operations');
      await transfer(tx, 'op_cost', 'too much', from, to, 1001);
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GameError);
    expect((err as GameError).code).toBe('insufficient_funds');
    expect(await cash(db, c.id)).toBe(1000);
  });

  it('treats a repeated idempotency key as a no-op', async () => {
    const c = await newCompany(db, { capital: 5000 });
    const run = () =>
      withTx(db, async (tx) => {
        const from = await companyAccount(tx, c.id, 'cash');
        const to = await systemAccount(tx, 'sink:operations');
        return transfer(tx, 'op_cost', 'once', from, to, 700, `test-once-${c.id}`);
      });
    const first = await run();
    const second = await run();
    expect(second).toBe(first);
    expect(await cash(db, c.id)).toBe(4300);
  });

  it('is append-only', async () => {
    await expect(db.query('UPDATE ledger_entries SET amount_cents = 1')).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM ledger_txns')).rejects.toThrow(/append-only/);
  });

  it('enforces balance at the database level too', async () => {
    await expect(
      withTx(db, async (tx) => {
        const t = await tx.query<{ id: number }>("INSERT INTO ledger_txns (kind) VALUES ('op_cost') RETURNING id");
        const acct = await systemAccount(tx, 'sink:operations');
        await tx.query('INSERT INTO ledger_entries (txn_id, account_id, amount_cents) VALUES ($1, $2, 5)', [t.rows[0].id, acct]);
      }),
    ).rejects.toThrow(/does not balance/);
  });
});
