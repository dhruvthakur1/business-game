// Runs a project-local PostgreSQL cluster for development (trust auth, no passwords).
// Uses the PostgreSQL binaries on PATH (initdb, pg_ctl, psql). Data lives in server/.pgdata.
//   node scripts/devdb.mjs start   -> init (first run), start, create databases
//   node scripts/devdb.mjs stop
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, '.pgdata');
const logFile = join(root, '.pgdata.log');
const port = process.env.DEV_PG_PORT ?? '5433';
const user = 'mercantile';
const databases = ['mercantile', 'mercantile_test'];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const isRunning = () => spawnSync('pg_ctl', ['status', '-D', dataDir], { stdio: 'ignore' }).status === 0;

const action = process.argv[2] ?? 'start';

if (action === 'stop') {
  if (isRunning()) run('pg_ctl', ['stop', '-D', dataDir, '-m', 'fast']);
  else console.log('Dev database is not running.');
  process.exit(0);
}

if (!existsSync(dataDir)) {
  console.log(`Initialising dev cluster in ${dataDir}`);
  run('initdb', ['-D', dataDir, '-U', user, '-A', 'trust', '-E', 'UTF8', '--no-locale']);
}

if (!isRunning()) {
  // stdio must be ignored: the postmaster inherits handles and would keep a piped parent waiting forever.
  const r = spawnSync('pg_ctl', ['start', '-D', dataDir, '-l', logFile, '-w', '-o', `-p ${port} -c listen_addresses=localhost`], { stdio: 'ignore' });
  if (r.status !== 0) {
    console.error(`pg_ctl start failed; see ${logFile}`);
    process.exit(1);
  }
  console.log(`Started dev database on port ${port}.`);
} else {
  console.log('Dev database already running.');
}

for (const db of databases) {
  const exists = execFileSync('psql', ['-h', 'localhost', '-p', port, '-U', user, '-d', 'postgres', '-tAc', `SELECT 1 FROM pg_database WHERE datname='${db}'`])
    .toString()
    .trim();
  if (exists !== '1') {
    run('psql', ['-h', 'localhost', '-p', port, '-U', user, '-d', 'postgres', '-c', `CREATE DATABASE ${db}`]);
  }
}

console.log(`Dev database ready: postgres://${user}@localhost:${port}/mercantile`);
