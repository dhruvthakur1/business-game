# Mercantile API

Fastify + PostgreSQL. All money is stored as integer cents.

## Scripts

| Command | What it does |
|---|---|
| `npm run db:start` / `db:stop` | Start/stop a project-local Postgres (port 5433, trust auth, `.pgdata/`) |
| `npm run migrate` | Apply pending migrations in `migrations/` |
| `npm run reset` | Drop everything, migrate, seed (dev only) |
| `npm run seed` | Upsert catalog; seed market makers + demo company if missing |
| `npm run dev` | API with reload on http://localhost:4100 |
| `npm test` | Integration tests against `mercantile_test` |

Environment: `DATABASE_URL`, `PORT` (4100), `TIME_SCALE` (60 — a 4h cycle takes 4 real minutes; use 1 for real time),
`DEMO_LOGIN=off` to disable the demo sign-in.

## How it works

- **Ledger** (`src/ledger.ts`): every money movement is a balanced transaction in `ledger_txns` / `ledger_entries`.
  A deferred constraint trigger rejects any transaction that does not sum to zero; ledger rows are append-only;
  a CHECK constraint stops company balances going negative (surfaced as `insufficient_funds`). System accounts
  (`faucet:*`, `sink:*`, `npc:*`) are where money enters and leaves the economy. Optional idempotency keys make
  retries safe.
- **Production** (`src/production.ts`): starting a job takes inputs out of the warehouse, charges the operating
  cost (with admin overhead) and sets `finishes_at`. Jobs settle lazily: `collect` atomically flips finished jobs
  from `running` to `collected` and credits goods, so it can never double-pay, then restarts jobs that have inputs.
  Output quality follows `min(mean input Q + research, lowest input + 1)`.
- **Research** (`src/research.ts`, rules in `shared/research.ts`): eight families with tiers at 50 / 250 / 1.5k / 6k /
  20k points. R&D Labs (Lv 3) turn 2 MWh into 25 research points per level per cycle; points go straight to the
  company's lab focus, or to the warehouse as a tradeable product (`research_points`) when no focus is set. Points
  in the warehouse can be applied to any family. A building whose family's tier is above its inputs' average
  quality gets a +1 research bonus, so research raises the quality cap one step at a time. The first company on
  the server to reach each family tier gets +500 XP.
- **Product designer & brands** (`src/brands.ts`, rules in `shared/designer.ts`): brands cost 5,000 CR, have
  unique names (case- and space-insensitive, with a character and profanity check), one of four logos, and at
  most three per company. A design picks a template (bread at the Bakery, car at the Car Factory, watch at the
  Watchmaker), material options and a tier (basic / premium ×1.4 inputs / luxury ×2.2 inputs, luxury needs
  reputation 40). It must pass the value check: price ≤ min(inputs × 1.8 + op cost, base reference × tier price
  band). Each design is its own product row, so the warehouse, exchange, contracts and NPC sales all work on it.
  A building set to a design consumes the extra inputs, pays the materials in cash and outputs the design.
  Brand reputation (0–100, starts at 10) decays 1% a day at the daily close and grows with the day's units sold,
  distinct buyers, their quality and on-time contract deliveries; NPC buyers pay up to +20% for it.
- **Personal wealth** (`src/wealth.ts`, rules in `shared/wealth.ts`): each company has an owner `wallet` account
  that is not company property (excluded from net worth, untouched by receivership). Money reaches it three ways,
  each in one ledger transaction (company cash → wallet + income-tax sink): a standing daily **salary** paid at the
  daily close, capped at 15% of the 7-day average operating profit; **dividends**, limited to the last 30 days'
  operating profit minus what was already paid out; and **owner withdrawals**, with an extra 10% tax. Every payout
  must leave 7 days of upkeep and debt service in company cash, and none is allowed while loans are late or upkeep
  is unpaid. Income tax is progressive on rolling 30-day payouts (0% to 50k, 10%, 15%, 25%). Luxury items are
  bought rung by rung per collection from the wallet, sold back at the category's buyback rate, and charged daily
  upkeep from the wallet at the close; an item whose upkeep can't be paid goes into storage (no prestige) instead
  of being seized. Prestige = Σ 100 × log10(price / 1,000) × rarity for displayed items + 100 per trophy.
- **Cash-flow history** (`GET /api/cashflow`): revenue (NPC sales, exchange and contract proceeds) and operating
  costs (op cost, upkeep, NPC and exchange/contract purchases net of refunds) per game day for the last 7 days.
- **Exchange** (`src/exchange.ts`): limit orders with price-time priority, executing at the resting order's
  price. Buyers lock `price × qty` in an escrow account; sellers move goods into the order. Each fill settles in
  one ledger transaction (buyer escrow → seller cash − 2% fee → fee sink, plus any price-improvement refund).
  Prices must sit within 0.5×–2× reference; self-trades are skipped; cancelling refunds escrow or goods.
  Reference prices move toward the 7-day VWAP at most ±10% per game day.
- **NPC markets** (`src/npc.ts`): a vendor sells raw inputs at reference price (sink); NPC buyers pay reference ×
  quality bonus with 100/90/80/70% volume tiers per game day (faucet).

- **Daily close** (`src/daily.ts`): when a game day ends, each company is settled in one transaction:
  loan installments first (EMI, daily amortization), then upkeep for every building (`upkeep × level`).
  If cash runs short, an automatic overdraft (up to 5,000 CR, 0.5%/day + 50 CR fee) covers upkeep and is repaid
  from later cash; anything beyond that becomes unpaid upkeep, which pauses production. A scheduler runs
  closes for every company whose day has ended (replaying at most 7 missed days after downtime).
- **Bank** (`src/bank.ts`): credit score = 300 + 600 × (0.30 on-time + 0.20 low debt + 0.15 age + 0.20 debt
  cover + 0.15 stability) minus penalty points. Starter loan (20,000 CR, once, Lv 2) and term loans (Lv 5, 3+
  game days old, up to 10× average daily operating cash flow, rate and minimum debt cover by score tier).
  Interest is destroyed; principal returns to the bank. Missed installments: 2% late fee, +0.10%/day penalty
  interest, −15 score; day 3 restructuring offer (term ×2, +0.05%/day, −30 score, 14-day borrowing pause);
  day 7 collections (50% of the day's revenue); day 14 receivership (orders cancelled, inventory at 80%,
  buildings at 60% of resale, first building protected); if debts still remain, bankruptcy: loans written off,
  restart with 50,000 CR and a 450 score.

- **Contracts** (`src/contracts.ts`): either party offers terms (product, units per delivery, minimum quality,
  unit price, frequency every 4h/daily/weekly, 4/8/24h window, up to 30 days); offers expire after 48 game hours.
  Accepting posts the seller's performance bond (10% of 7 days of value) and schedules every delivery window.
  When a window opens, the buyer's cash moves to escrow; the delivery happens automatically as soon as the seller
  holds enough goods at the minimum quality (lowest qualifying quality first) and settles escrow to the seller minus
  a 1% fee. Late deliveries pay 1%/game hour (max 10%) from the bond to the buyer; nothing delivered 24h after the
  window is a seller breach (escrow refunded plus 10% from the bond); a buyer who can't fund pays 5% to the seller.
  Breaches end the contract; 3 breaches in 30 game days suspend contract activity for 7 days. Either side can end
  with 72h notice and no penalty. The scheduler (`src/contractWork.ts`) advances contracts every 5 seconds.
- **Reliability**: value-weighted, (on-time value + 80% × 50,000 CR) / (owed value + 50,000 CR), from deliveries
  owed as a seller; "verified" after 3 distinct buyers.
- **RFQ board** (`src/rfq.ts`): a buyer posts a request with a max price and minimum reliability; sellers place
  sealed bids for 24 game hours; afterwards the buyer awards a bid and the contract starts with the seller's bond.
- **NPC counterparties** (`src/bots.ts`): the seeded market makers answer offers after a game hour (sell at ≥98% of
  reference, buy at ≤103%), bid on players' RFQs, keep a few RFQs of their own on the board and award them to the
  cheapest bid. NPC sellers restock goods they lack, so they never breach.

- **XP and levels** (`src/xp.ts`, rules in `shared/levels.ts`): companies earn XP for production value-add
  (output minus inputs at base reference prices, 0.2 XP per CR), contract deliveries (sellers 0.05 XP per CR,
  half if late, capped at 300 XP per buyer per game day; buyers 0.01 XP per CR) and trading (exchange fills and NPC
  sales, 0.01 XP per CR, capped at 400 XP per game day across all market activity). Reaching Lv 2 takes 1,000 XP
  and each further level needs 25% more. Levels never drop and gate buildings, the starter loan (Lv 2), contracts
  and term loans (Lv 5). NPC companies don't earn XP.

- **Leagues** (`src/leagues.ts`, rules in `shared/leagues.ts`): game weeks of 7 game days. Every player company is
  seated in a group of up to 30 by division (conservative net worth: Startup, Small, Mid, Large, Conglomerate) and
  tier (Bronze → Tycoon). The Industry League scores production value-add; points = min(1,500, 1,000 × metric ÷
  the division's P90 from last week), with a baseline until there is history. At week close the top 7 of 30 promote
  (0 points can't promote) and the bottom 5 relegate, scaled for smaller groups; Bronze doesn't relegate and Tycoon
  doesn't promote.
- **Contests** (`src/contestMetrics.ts`): three rotate each week from Harvest Sprint, Margin Master, Reliable
  Supplier Week, Power Rush, Quality Quest, Balance Sheet Builder and Newcomer Cup, each computed from real records
  (collected jobs, trades, contract deliveries, NPC sales, the ledger) with eligibility rules and off-price
  exclusion (outside 0.85–1.15× reference). Each group's #1 gets a cosmetic reward and a CR prize capped at
  min(25,000 × division multiplier, 5% of the division's median weekly profit); top 3/10 and 500+ points earn
  cosmetics. Results and trophies are stored. The scheduler closes finished weeks every 30 seconds.

## API

Public: `GET /api/health`, `GET /api/catalog`, `GET /api/market`, `GET /api/market/:productId`,
`POST /api/companies` `{name, region}` → `{token}`, `POST /api/session/demo` → `{token}`.

With `Authorization: Bearer <token>`: `GET /api/me`, `GET /api/activity`, `POST /api/buildings` `{typeId}`,
`POST /api/buildings/:id/start` `{inputQuality?}`, `POST /api/buildings/:id/upgrade`, `POST /api/collect`
`{buildingIds?, restart}`, `GET /api/orders`, `POST /api/orders` `{productId, side, qty, priceCents, quality}`,
`DELETE /api/orders/:id`, `POST /api/npc/buy` `{productId, qty}`, `POST /api/npc/sell` `{productId, qty, quality}`,
`GET /api/bank`, `POST /api/loans` `{product: 'starter'|'term', principalCents?, days?}`, `POST /api/loans/:id/repay`,
`POST /api/loans/:id/restructure`, `POST /api/upkeep/pay`,
`GET /api/contracts`, `POST /api/contracts` `{counterpartyId, role: 'buy'|'sell', terms}`, `POST /api/contracts/:id/accept|reject|terminate`,
`GET /api/suppliers?productId=`, `GET /api/rfqs`, `POST /api/rfqs`, `POST /api/rfqs/:id/bids` `{priceCents}`,
`POST /api/rfqs/:id/award` `{bidId}`, `POST /api/rfqs/:id/cancel`.
`GET /api/leagues`, `GET /api/contests/:id`.
`GET /api/research`, `POST /api/research/focus` `{family | null}`, `POST /api/research/apply` `{family, points}`.
`GET /api/designer`, `GET /api/brands/check?name=`, `POST /api/brands` `{name, logo}`,
`POST /api/designs` `{brandId, templateId, slots, tier, priceCents}`, `POST /api/buildings/:id/design` `{designId | null}`.
`GET /api/wealth`, `POST /api/wealth/salary` `{salaryCents}`, `POST /api/wealth/dividend` `{amountCents}`,
`POST /api/wealth/withdraw` `{amountCents}`, `POST /api/wealth/items` `{itemId}`, `POST /api/wealth/items/:itemId/sell`,
`GET /api/cashflow`.

Dev only (`DEMO_LOGIN` on): `POST /api/dev/close-day` runs the company's next daily close now;
`POST /api/dev/advance-contracts` `{hours}` shifts the company's contract windows and RFQ deadlines into the past
by that many game hours and processes them.
`POST /api/dev/close-week` closes the current league week now and opens the next.

## Not built yet

Wages, mortgages, lines of credit and savings, player bonds, a player auction in receivership, freight and transit time for contract deliveries, contract disputes, level-up rewards, monthly and yearly contests, a friends/rivals board, linked-account exclusion, the recipes that research tiers name (most of those products don't exist yet),
dress and sneaker templates (no garment factory yet), luxury auctions and player Luxury Stores, renting, real authentication (sessions are bearer tokens with no password), rate limiting, and
linked-account detection.
