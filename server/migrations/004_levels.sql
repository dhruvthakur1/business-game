-- Company XP and levelling.

ALTER TABLE companies ADD COLUMN xp bigint NOT NULL DEFAULT 0 CHECK (xp >= 0);

-- Existing companies start at the bottom of their current level (shared/levels.ts xpForLevel).
UPDATE companies SET xp = ROUND(4000 * (power(1.25, level - 1) - 1));

-- Value of the inputs a job consumed, at base reference prices, so collect can award XP for value added.
ALTER TABLE production_jobs ADD COLUMN input_value_cents bigint NOT NULL DEFAULT 0;

-- Jobs already running get their input value from the recipe, so their first collect isn't over-credited.
UPDATE production_jobs j SET input_value_cents = v.total
FROM (
  SELECT j2.id, SUM(rl.qty * b.level * p.ref_price_cents) AS total
  FROM production_jobs j2
  JOIN buildings b ON b.id = j2.building_id
  JOIN recipe_lines rl ON rl.building_type_id = b.building_type_id AND rl.direction = 'in'
  JOIN products p ON p.id = rl.product_id
  WHERE j2.state = 'running'
  GROUP BY j2.id
) v
WHERE j.id = v.id;

CREATE TABLE xp_events (
  id          bigserial PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  day         int NOT NULL,
  source      text NOT NULL CHECK (source IN ('production', 'contract_sale', 'contract_purchase', 'trade', 'npc_sale', 'seed')),
  -- Daily caps are counted per cap key (e.g. 'market', 'contract:<buyer id>').
  cap_key     text,
  amount      int NOT NULL CHECK (amount > 0),
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX xp_events_company ON xp_events (company_id, id DESC);
CREATE INDEX xp_events_cap ON xp_events (company_id, day, cap_key);
