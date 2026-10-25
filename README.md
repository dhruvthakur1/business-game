# Mercantile

A persistent, player-driven business tycoon game.

| Folder | What it is |
|---|---|
| `server/` | Node + TypeScript API (Fastify, PostgreSQL): double-entry ledger, production jobs, exchange, NPC markets |
| `web/` | React + TypeScript client (Vite) |
| `shared/` | Game catalog and formulas used by both, so previews match settlement |
| `design/` | Design canvas source, building and product art |

## Run it locally

Needs Node 20+ and PostgreSQL binaries (`initdb`, `pg_ctl`, `psql`) on `PATH`.

```bash
cd server
npm install
npm run db:start   # project-local Postgres on port 5433 (data in server/.pgdata, no password)
npm run reset      # create schema + seed catalog, market makers and the demo company
npm run dev        # API on http://localhost:4100
```

In a second terminal:

```bash
cd web
npm install
npm run dev        # http://localhost:5173, proxies /api to :4100
```

Open the app and choose **Found a company** (creates an account and a company), **Sign in**, or, in development,
**Use demo company**. The seeded demo company also has a dev-only login, listed in `server/README.md`.

To use your own PostgreSQL server instead of the local cluster, set `DATABASE_URL`
(e.g. `postgres://user:pass@localhost:5432/mercantile`) before `npm run reset` / `npm run dev`.

## Tests

```bash
cd server && npm test   # ledger, production, exchange and HTTP tests (uses database mercantile_test)
cd web && npm test      # economy formula tests
```
