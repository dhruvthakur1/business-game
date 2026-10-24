import pg from 'pg';
import { config } from './config';

// BIGINT (int8) comes back as a string by default; our values stay well inside 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString = config.databaseUrl): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Runs fn inside a transaction; rolls back on any thrown error. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
