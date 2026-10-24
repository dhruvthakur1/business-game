-- Daily close (upkeep), bank loans, credit history and delinquency.

ALTER TABLE companies
  ADD COLUMN created_day           int NOT NULL DEFAULT 0,
  -- Last game day whose close (installments, upkeep) has been processed.
  ADD COLUMN last_settled_day      int NOT NULL DEFAULT 0,
  -- Points subtracted from the formula credit score (missed payments, restructuring); recovers on time.
  ADD COLUMN credit_penalty        int NOT NULL DEFAULT 0 CHECK (credit_penalty >= 0),
  -- Upkeep that neither cash nor the overdraft could cover. Production is blocked while > 0.
  ADD COLUMN upkeep_arrears_cents  bigint NOT NULL DEFAULT 0 CHECK (upkeep_arrears_cents >= 0),
  ADD COLUMN borrow_blocked_until  int,
  ADD COLUMN starter_loan_taken    boolean NOT NULL DEFAULT false,
  ADD COLUMN bankruptcies          int NOT NULL DEFAULT 0;

CREATE TABLE loans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product            text NOT NULL CHECK (product IN ('starter', 'term', 'overdraft')),
  principal_cents    bigint NOT NULL CHECK (principal_cents >= 0),
  -- Daily rate as a fraction, e.g. 0.0015 = 0.15%/day.
  daily_rate         numeric(8, 6) NOT NULL,
  term_days          int NOT NULL,
  installment_cents  bigint NOT NULL,
  outstanding_cents  bigint NOT NULL CHECK (outstanding_cents >= 0),
  -- Amount overdue (missed installments, late fees, penalty interest).
  arrears_cents      bigint NOT NULL DEFAULT 0 CHECK (arrears_cents >= 0),
  -- The part of arrears that is principal (repaid to the bank); the rest is interest/fees (destroyed).
  arrears_principal_cents bigint NOT NULL DEFAULT 0 CHECK (arrears_principal_cents >= 0 AND arrears_principal_cents <= arrears_cents),
  -- Scheduled installments that have come due so far.
  installments_due   int NOT NULL DEFAULT 0,
  installments_paid  int NOT NULL DEFAULT 0,
  days_past_due      int NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'late', 'restructure_offered', 'collections', 'repaid', 'defaulted')),
  restructured       boolean NOT NULL DEFAULT false,
  created_day        int NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loans_company_open ON loans (company_id) WHERE status NOT IN ('repaid', 'defaulted');
-- At most one open overdraft per company.
CREATE UNIQUE INDEX loans_one_overdraft ON loans (company_id) WHERE product = 'overdraft' AND status NOT IN ('repaid', 'defaulted');

-- Repayment history drives the on-time factor of the credit score.
CREATE TABLE loan_events (
  id            bigserial PRIMARY KEY,
  loan_id       uuid NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  day           int NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('disbursed', 'paid', 'missed', 'late_fee', 'restructured', 'collections', 'liquidation', 'repaid', 'defaulted', 'overdraft_draw')),
  amount_cents  bigint NOT NULL DEFAULT 0,
  note          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loan_events_company ON loan_events (company_id, id DESC);

-- One row per company per closed game day; feeds the stability and cover factors.
CREATE TABLE company_days (
  company_id               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  day                      int NOT NULL,
  operating_flow_cents     bigint NOT NULL,
  upkeep_cents             bigint NOT NULL,
  debt_service_cents       bigint NOT NULL,
  cash_cents               bigint NOT NULL,
  PRIMARY KEY (company_id, day)
);
