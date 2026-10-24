import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, type Db } from './db';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Applies pending SQL migrations in filename order. With reset, drops everything first (dev/test only). */
export async function migrate(db: Db, opts: { reset?: boolean } = {}): Promise<string[]> {
  if (opts.reset) {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = createPool();
  migrate(db, { reset: process.argv.includes('--reset') })
    .then((applied) => console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.'))
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}
