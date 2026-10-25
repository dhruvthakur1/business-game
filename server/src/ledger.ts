import type { Tx } from './db';
import { badRequest, mapDbError } from './errors';

/** Company-owned account kinds. */
export type CompanyAccountKind = 'cash' | 'escrow' | 'bond' | 'wallet';

/** System accounts are the faucets and sinks that create and destroy money. */
export type SystemAccountKind =
  | 'faucet:starting_capital'
  | 'sink:construction'
  | 'sink:upgrades'
  | 'sink:operations'
  | 'sink:materials'
  | 'sink:brands'
  | 'sink:income_tax'
  | 'sink:item_upkeep'
  | 'npc:luxury_shop'
  | 'sink:store_fees'
  | 'sink:exchange_fees'
  | 'npc:vendor'
  | 'npc:buyer'
  | 'sink:upkeep'
  | 'sink:interest'
  | 'npc:bank'
  | 'npc:liquidator'
  | 'faucet:bankruptcy'
  | 'sink:contract_fees'
  | 'npc:restock'
  | 'faucet:contest_prizes';

export type TxnKind =
  | 'starting_capital'
  | 'building_purchase'
  | 'building_upgrade'
  | 'op_cost'
  | 'brand_registration'
  | 'owner_payout'
  | 'luxury_purchase'
  | 'luxury_sale'
  | 'item_upkeep'
  | 'store_sale'
  | 'npc_purchase'
  | 'npc_sale'
  | 'order_lock'
  | 'order_refund'
  | 'order_cancel'
  | 'trade_settlement'
  | 'upkeep'
  | 'loan_disbursement'
  | 'loan_payment'
  | 'loan_fee'
  | 'liquidation'
  | 'bankruptcy_grant'
  | 'contract_bond'
  | 'contract_bond_release'
  | 'contract_funding'
  | 'contract_settlement'
  | 'contract_penalty'
  | 'contract_refund'
  | 'contest_prize';

export interface Entry {
  accountId: number;
  amount: number;
}

export interface PostInput {
  kind: TxnKind;
  memo: string;
  entries: Entry[];
  /** Replaying a post with the same key is a no-op that returns the original transaction id. */
  idempotencyKey?: string;
}

export async function systemAccount(tx: Tx, kind: SystemAccountKind): Promise<number> {
  const found = await tx.query<{ id: number }>('SELECT id FROM accounts WHERE company_id IS NULL AND kind = $1', [kind]);
  if (found.rows[0]) return found.rows[0].id;
  const created = await tx.query<{ id: number }>(
    `INSERT INTO accounts (company_id, kind) VALUES (NULL, $1)
     ON CONFLICT (kind) WHERE company_id IS NULL DO UPDATE SET kind = EXCLUDED.kind RETURNING id`,
    [kind],
  );
  return created.rows[0].id;
}

export async function companyAccount(tx: Tx, companyId: string, kind: CompanyAccountKind): Promise<number> {
  const res = await tx.query<{ id: number }>('SELECT id FROM accounts WHERE company_id = $1 AND kind = $2', [companyId, kind]);
  if (!res.rows[0]) throw new Error(`Company ${companyId} has no ${kind} account`);
  return res.rows[0].id;
}

/**
 * Posts a balanced double-entry transaction and updates materialized balances in the same DB transaction.
 * Accounts are locked in id order to avoid deadlocks between concurrent posts.
 * A company balance going negative violates a CHECK constraint and surfaces as insufficient_funds.
 */
export async function post(tx: Tx, input: PostInput): Promise<number> {
  const merged = new Map<number, number>();
  for (const e of input.entries) {
    if (!Number.isSafeInteger(e.amount)) throw badRequest('Ledger amounts must be whole cents');
    merged.set(e.accountId, (merged.get(e.accountId) ?? 0) + e.amount);
  }
  const entries = [...merged].filter(([, amt]) => amt !== 0);
  const sum = entries.reduce((s, [, amt]) => s + amt, 0);
  if (sum !== 0) throw new Error(`Unbalanced ledger post (${input.kind}): sum ${sum}`);
  if (entries.length === 0) return 0;

  if (input.idempotencyKey) {
    const prior = await tx.query<{ id: number }>('SELECT id FROM ledger_txns WHERE idempotency_key = $1', [input.idempotencyKey]);
    if (prior.rows[0]) return prior.rows[0].id;
  }

  const ids = entries.map(([id]) => id).sort((a, b) => a - b);
  await tx.query('SELECT id FROM accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids]);

  try {
    const txn = await tx.query<{ id: number }>(
      'INSERT INTO ledger_txns (kind, memo, idempotency_key) VALUES ($1, $2, $3) RETURNING id',
      [input.kind, input.memo, input.idempotencyKey ?? null],
    );
    const txnId = txn.rows[0].id;
    await tx.query(
      `INSERT INTO ledger_entries (txn_id, account_id, amount_cents)
       SELECT $1, a, b FROM unnest($2::bigint[], $3::bigint[]) AS t(a, b)`,
      [txnId, entries.map(([id]) => id), entries.map(([, amt]) => amt)],
    );
    await tx.query(
      `UPDATE accounts SET balance_cents = balance_cents + t.b
       FROM unnest($1::bigint[], $2::bigint[]) AS t(a, b) WHERE accounts.id = t.a`,
      [entries.map(([id]) => id), entries.map(([, amt]) => amt)],
    );
    return txnId;
  } catch (err) {
    throw mapDbError(err);
  }
}

/** Convenience: move `amount` cents from one account to another. */
export function transfer(tx: Tx, kind: TxnKind, memo: string, from: number, to: number, amount: number, idempotencyKey?: string) {
  if (amount < 0) throw new Error('transfer amount must be positive');
  return post(tx, { kind, memo, idempotencyKey, entries: [{ accountId: from, amount: -amount }, { accountId: to, amount }] });
}

export async function balance(tx: Tx, accountId: number): Promise<number> {
  const res = await tx.query<{ balance_cents: number }>('SELECT balance_cents FROM accounts WHERE id = $1', [accountId]);
  return res.rows[0]?.balance_cents ?? 0;
}

export const toCents = (cr: number) => Math.round(cr * 100);
export const fromCents = (cents: number) => cents / 100;
