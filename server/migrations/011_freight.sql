-- Freight and transit: goods bought on the exchange or delivered under contract travel as shipments and land in
-- the buyer's warehouse when they arrive. The seller pays freight.

CREATE TABLE shipments (
  id             bigserial PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_company   uuid REFERENCES companies(id) ON DELETE SET NULL,
  product_id     text NOT NULL REFERENCES products(id),
  quality        smallint NOT NULL CHECK (quality BETWEEN 0 AND 5),
  qty            bigint NOT NULL CHECK (qty > 0),
  from_region    text NOT NULL,
  to_region      text NOT NULL,
  freight_cents  bigint NOT NULL DEFAULT 0,
  source         text NOT NULL CHECK (source IN ('trade', 'contract')),
  source_ref     text,
  shipped_at     timestamptz NOT NULL DEFAULT now(),
  arrives_at     timestamptz NOT NULL,
  delivered_at   timestamptz
);
CREATE INDEX shipments_due ON shipments (arrives_at) WHERE delivered_at IS NULL;
CREATE INDEX shipments_company ON shipments (company_id) WHERE delivered_at IS NULL;

ALTER TABLE trades ADD COLUMN freight_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE contract_deliveries ADD COLUMN freight_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE contract_deliveries ADD COLUMN arrives_at timestamptz;
