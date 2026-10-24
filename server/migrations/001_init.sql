-- Mercantile core schema: catalog, companies, double-entry ledger, inventory, production, exchange.
-- All money is stored as BIGINT cents (1 CR = 100 cents).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Catalog (seeded from shared/catalog.ts) ----------
CREATE TABLE products (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  tier             text NOT NULL,
  ref_price_cents  bigint NOT NULL CHECK (ref_price_cents > 0),
  unit             text,
  unit_weight      numeric NOT NULL DEFAULT 1,
  npc_vendor       boolean NOT NULL DEFAULT false
);

CREATE TABLE building_types (
  id                    text PRIMARY KEY,
  name                  text NOT NULL,
  tag                   text NOT NULL,
  build_cost_cents      bigint NOT NULL,
  unlock_level          int NOT NULL,
  cycle_minutes         int NOT NULL,
  op_cost_cents         bigint NOT NULL,
  upkeep_per_day_cents  bigint NOT NULL
);

CREATE TABLE recipe_lines (
  building_type_id  text NOT NULL REFERENCES building_types(id) ON DELETE CASCADE,
  product_id        text NOT NULL REFERENCES products(id),
  direction         text NOT NULL CHECK (direction IN ('in', 'out')),
  qty               int NOT NULL CHECK (qty > 0),
  PRIMARY KEY (building_type_id, product_id, direction)
);

-- ---------- Companies & sessions ----------
CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  region      text NOT NULL DEFAULT 'north' CHECK (region IN ('north', 'east', 'south', 'west')),
  level       int NOT NULL DEFAULT 1,
  is_npc      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_name_unique ON companies (lower(name));

CREATE TABLE sessions (
  token       text PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Double-entry ledger ----------
-- Company accounts may never go negative; system accounts (faucets/sinks) may.
CREATE TABLE accounts (
  id             bigserial PRIMARY KEY,
  company_id     uuid REFERENCES companies(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  balance_cents  bigint NOT NULL DEFAULT 0,
  CONSTRAINT company_accounts_not_negative CHECK (company_id IS NULL OR balance_cents >= 0)
);
CREATE UNIQUE INDEX accounts_company_kind ON accounts (company_id, kind) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX accounts_system_kind ON accounts (kind) WHERE company_id IS NULL;

CREATE TABLE ledger_txns (
  id               bigserial PRIMARY KEY,
  kind             text NOT NULL,
  memo             text NOT NULL DEFAULT '',
  idempotency_key  text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id            bigserial PRIMARY KEY,
  txn_id        bigint NOT NULL REFERENCES ledger_txns(id),
  account_id    bigint NOT NULL REFERENCES accounts(id),
  amount_cents  bigint NOT NULL CHECK (amount_cents <> 0)
);
CREATE INDEX ledger_entries_account ON ledger_entries (account_id, id DESC);
CREATE INDEX ledger_entries_txn ON ledger_entries (txn_id);

-- Every transaction must balance to zero; checked at commit so multi-row inserts work.
CREATE FUNCTION ledger_txn_balanced() RETURNS trigger AS $$
DECLARE total bigint;
BEGIN
  SELECT COALESCE(SUM(amount_cents), 0) INTO total FROM ledger_entries WHERE txn_id = NEW.txn_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not balance (sum %)', NEW.txn_id, total USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_txn_balanced();

-- Ledger rows are append-only.
CREATE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_txns_no_update BEFORE UPDATE OR DELETE ON ledger_txns FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- ---------- Inventory ----------
CREATE TABLE inventory (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id  text NOT NULL REFERENCES products(id),
  quality     smallint NOT NULL CHECK (quality BETWEEN 0 AND 5),
  qty         bigint NOT NULL CHECK (qty >= 0),
  PRIMARY KEY (company_id, product_id, quality)
);

-- ---------- Buildings & production ----------
CREATE TABLE buildings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  building_type_id  text NOT NULL REFERENCES building_types(id),
  name              text NOT NULL,
  level             int NOT NULL DEFAULT 1 CHECK (level >= 1),
  plot              int NOT NULL CHECK (plot >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, plot)
);

CREATE TABLE production_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id     uuid NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  started_at      timestamptz NOT NULL,
  finishes_at     timestamptz NOT NULL,
  state           text NOT NULL CHECK (state IN ('running', 'collected')),
  output_product  text REFERENCES products(id),
  output_qty      int NOT NULL DEFAULT 0,
  output_quality  smallint NOT NULL DEFAULT 0,
  input_quality   smallint NOT NULL DEFAULT 0,
  collected_at    timestamptz
);
-- One job at a time per building.
CREATE UNIQUE INDEX production_jobs_one_running ON production_jobs (building_id) WHERE state = 'running';

-- ---------- Exchange ----------
CREATE TABLE orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id   text NOT NULL REFERENCES products(id),
  side         text NOT NULL CHECK (side IN ('buy', 'sell')),
  price_cents  bigint NOT NULL CHECK (price_cents > 0),
  qty          bigint NOT NULL CHECK (qty > 0),
  remaining    bigint NOT NULL CHECK (remaining >= 0),
  quality      smallint NOT NULL DEFAULT 0,   -- sell: quality offered; buy: minimum quality
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled')),
  seq          bigserial,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_book ON orders (product_id, side, status, price_cents, seq);
CREATE INDEX orders_company ON orders (company_id, status);

CREATE TABLE trades (
  id             bigserial PRIMARY KEY,
  product_id     text NOT NULL REFERENCES products(id),
  buy_order_id   uuid NOT NULL REFERENCES orders(id),
  sell_order_id  uuid NOT NULL REFERENCES orders(id),
  buyer_id       uuid NOT NULL REFERENCES companies(id),
  seller_id      uuid NOT NULL REFERENCES companies(id),
  price_cents    bigint NOT NULL,
  qty            bigint NOT NULL,
  quality        smallint NOT NULL,
  fee_cents      bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trades_product_time ON trades (product_id, created_at DESC);

-- NPC buyer volume per company/product/day, for the falling price tiers.
CREATE TABLE npc_sales (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id  text NOT NULL REFERENCES products(id),
  day         int NOT NULL,   -- game day number (see gameDay())
  qty         bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, product_id, day)
);

-- Reference price = 7-day volume-weighted average of trades, moved at most ±10% per game day.
CREATE TABLE reference_prices (
  product_id   text PRIMARY KEY REFERENCES products(id),
  price_cents  bigint NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
