import { buildApp } from './app';
import { config } from './config';
import { createPool } from './db';
import { refreshReferencePrices } from './exchange';
import { runDueClosures } from './daily';
import { processContracts } from './contractWork';
import { runLeagueCycle } from './leagues';
import { migrate } from './migrate';
import { pruneSessions } from './auth';

const db = createPool();
await migrate(db);

const app = buildApp(db, { logger: true });

// Reference prices move toward the 7-day VWAP once per game day.
const dayMs = (24 * 60 * 60_000) / config.timeScale;
const refresh = () => refreshReferencePrices(db).catch((err) => app.log.error(err, 'reference price refresh failed'));
await refresh();
const timer = setInterval(refresh, dayMs);

// Daily close (installments, upkeep, delinquency) for every company whose game day has ended.
const close = () =>
  runDueClosures(db)
    .then((n) => n > 0 && app.log.info(`Closed ${n} company-day(s)`))
    .catch((err) => app.log.error(err, 'daily close failed'));
await close();
const closeTimer = setInterval(close, Math.min(60_000, dayMs / 4));

// Contract deliveries, offer/RFQ expiry and NPC counterparties.
const contracts = () => processContracts(db).catch((err) => app.log.error(err, 'contract processing failed'));
await contracts();
const contractTimer = setInterval(contracts, 5_000);

// League weeks: close finished weeks (promotion, relegation, prizes), open the next, seat new companies.
const leagues = () => runLeagueCycle(db).catch((err) => app.log.error(err, 'league cycle failed'));
await leagues();
const leagueTimer = setInterval(leagues, 30_000);

// Expired sessions are deleted hourly.
const prune = () => pruneSessions(db).catch((err) => app.log.error(err, 'session prune failed'));
await prune();
const pruneTimer = setInterval(prune, 60 * 60_000);

await app.listen({ port: config.port, host: '127.0.0.1' });
app.log.info(`Mercantile API on http://localhost:${config.port} (time scale ×${config.timeScale})`);

const shutdown = async () => {
  clearInterval(timer);
  clearInterval(closeTimer);
  clearInterval(contractTimer);
  clearInterval(leagueTimer);
  clearInterval(pruneTimer);
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
