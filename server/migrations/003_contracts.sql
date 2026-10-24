-- Supply contracts with escrowed deliveries and performance bonds, and the RFQ (tender) board.

ALTER TABLE companies ADD COLUMN contracts_suspended_until timestamptz;

CREATE TABLE contracts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id              uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  seller_id             uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  proposer_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id            text NOT NULL REFERENCES products(id),
  qty                   int NOT NULL CHECK (qty > 0),
  min_quality           smallint NOT NULL CHECK (min_quality BETWEEN 0 AND 5),
  price_cents           bigint NOT NULL CHECK (price_cents > 0),
  frequency_hours       int NOT NULL,
  window_hours          int NOT NULL CHECK (window_hours <= frequency_hours),
  term_days             int NOT NULL CHECK (term_days BETWEEN 1 AND 30),
  status                text NOT NULL CHECK (status IN ('offered', 'rejected', 'expired', 'withdrawn', 'active', 'completed', 'terminated_by_notice', 'terminated_for_breach')),
  bond_cents            bigint NOT NULL DEFAULT 0,
  -- Bond still held for this contract (penalties are paid out of it).
  bond_remaining_cents  bigint NOT NULL DEFAULT 0 CHECK (bond_remaining_cents >= 0),
  offer_expires_at      timestamptz,
  accepted_at           timestamptz,
  notice_ends_at        timestamptz,
  ended_at              timestamptz,
  end_reason            text,
  rfq_id                uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_id <> seller_id)
);
CREATE INDEX contracts_buyer ON contracts (buyer_id, status);
CREATE INDEX contracts_seller ON contracts (seller_id, status);

CREATE TABLE contract_deliveries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id        uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  seq                int NOT NULL,
  window_start       timestamptz NOT NULL,
  window_end         timestamptz NOT NULL,
  value_cents        bigint NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'funded', 'unfunded', 'settled', 'breached', 'cancelled')),
  funded_cents       bigint NOT NULL DEFAULT 0,
  delivered_at       timestamptz,
  delivered_quality  smallint,
  late_hours         int NOT NULL DEFAULT 0,
  penalty_cents      bigint NOT NULL DEFAULT 0,
  fee_cents          bigint NOT NULL DEFAULT 0,
  resolved_at        timestamptz,
  UNIQUE (contract_id, seq)
);
CREATE INDEX contract_deliveries_due ON contract_deliveries (status, window_start) WHERE status IN ('pending', 'funded');

CREATE TABLE rfqs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id        text NOT NULL REFERENCES products(id),
  qty               int NOT NULL CHECK (qty > 0),
  min_quality       smallint NOT NULL CHECK (min_quality BETWEEN 0 AND 5),
  max_price_cents   bigint NOT NULL CHECK (max_price_cents > 0),
  frequency_hours   int NOT NULL,
  window_hours      int NOT NULL CHECK (window_hours <= frequency_hours),
  term_days         int NOT NULL CHECK (term_days BETWEEN 1 AND 30),
  min_reliability   numeric(5, 2) NOT NULL DEFAULT 0,
  closes_at         timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awarded', 'expired', 'cancelled')),
  contract_id       uuid REFERENCES contracts(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rfqs_open ON rfqs (status, closes_at);

CREATE TABLE rfq_bids (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id       uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  seller_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  price_cents  bigint NOT NULL CHECK (price_cents > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, seller_id)
);

ALTER TABLE contracts ADD CONSTRAINT contracts_rfq_fk FOREIGN KEY (rfq_id) REFERENCES rfqs(id);

-- Every company gets a bond account for performance bonds.
INSERT INTO accounts (company_id, kind) SELECT id, 'bond' FROM companies ON CONFLICT DO NOTHING;
