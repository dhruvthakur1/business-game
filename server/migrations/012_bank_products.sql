-- Building mortgages (with a lien on the building), a revolving line of credit, and company savings.

ALTER TABLE loans DROP CONSTRAINT loans_product_check;
ALTER TABLE loans ADD CONSTRAINT loans_product_check CHECK (product IN ('starter', 'term', 'overdraft', 'mortgage', 'credit_line'));

-- Mortgages: the building they are secured on. Receivership sells it to repay this loan first.
ALTER TABLE loans ADD COLUMN building_id uuid REFERENCES buildings(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX loans_one_mortgage_per_building ON loans (building_id) WHERE product = 'mortgage' AND status NOT IN ('repaid', 'defaulted');

-- Line of credit: the current limit and when it was last reviewed. outstanding_cents is the drawn balance.
ALTER TABLE loans ADD COLUMN credit_limit_cents bigint;
ALTER TABLE loans ADD COLUMN limit_reviewed_day int;
CREATE UNIQUE INDEX loans_one_credit_line ON loans (company_id) WHERE product = 'credit_line' AND status NOT IN ('repaid', 'defaulted');

ALTER TABLE loan_events DROP CONSTRAINT loan_events_kind_check;
ALTER TABLE loan_events ADD CONSTRAINT loan_events_kind_check CHECK (kind IN (
  'disbursed', 'paid', 'missed', 'late_fee', 'restructured', 'collections', 'liquidation', 'repaid', 'defaulted', 'overdraft_draw',
  'credit_draw', 'credit_repay', 'limit_review', 'closed'));

INSERT INTO accounts (company_id, kind) SELECT id, 'savings' FROM companies ON CONFLICT DO NOTHING;
