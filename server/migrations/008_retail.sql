-- Retail: supermarket shelves (cycle jobs selling to NPC shoppers) and luxury store listings bought by wallets.

-- Standing shelf setting for a supermarket: what it stocks each cycle and at what price.
ALTER TABLE buildings
  ADD COLUMN shelf_product_id text REFERENCES products(id),
  ADD COLUMN shelf_quality smallint CHECK (shelf_quality BETWEEN 0 AND 5),
  ADD COLUMN shelf_price_cents bigint CHECK (shelf_price_cents > 0);

-- A supermarket cycle is a production job: output_* is what was stocked, settled at collect.
ALTER TABLE production_jobs
  ADD COLUMN retail_price_cents bigint,
  ADD COLUMN sold_qty int,
  ADD COLUMN proceeds_cents bigint;

CREATE TABLE store_listings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id  uuid NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id   text NOT NULL REFERENCES products(id),
  quality      smallint NOT NULL CHECK (quality BETWEEN 0 AND 5),
  qty          int NOT NULL CHECK (qty >= 0),
  price_cents  bigint NOT NULL CHECK (price_cents > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX store_listings_open ON store_listings (product_id) WHERE qty > 0;

CREATE TABLE store_sales (
  id           bigserial PRIMARY KEY,
  listing_id   uuid REFERENCES store_listings(id) ON DELETE SET NULL,
  seller_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  buyer_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id   text NOT NULL REFERENCES products(id),
  quality      smallint NOT NULL,
  price_cents  bigint NOT NULL,
  fee_cents    bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Store-bought pieces carry their own quality and prestige rarity.
ALTER TABLE personal_items
  ADD COLUMN quality smallint,
  ADD COLUMN rarity text CHECK (rarity IN ('common', 'limited', 'unique'));
