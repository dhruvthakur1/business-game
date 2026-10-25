-- Personal wealth: a wallet account per company owner, salary setting, payouts (taxed) and luxury items.

INSERT INTO accounts (company_id, kind) SELECT id, 'wallet' FROM companies ON CONFLICT DO NOTHING;

-- Standing daily salary, paid at the daily close (capped there at 15% of 7-day average operating profit).
ALTER TABLE companies ADD COLUMN salary_cents bigint NOT NULL DEFAULT 0 CHECK (salary_cents >= 0);

CREATE TABLE owner_payouts (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('salary', 'dividend', 'withdrawal')),
  day          int NOT NULL,
  gross_cents  bigint NOT NULL CHECK (gross_cents > 0),
  tax_cents    bigint NOT NULL CHECK (tax_cents >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owner_payouts_company_day ON owner_payouts (company_id, day);

CREATE TABLE personal_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id      text NOT NULL,
  price_cents  bigint NOT NULL,
  -- Stored items (upkeep unpaid) are kept but not displayed and earn no prestige.
  stored       boolean NOT NULL DEFAULT false,
  bought_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, item_id)
);
