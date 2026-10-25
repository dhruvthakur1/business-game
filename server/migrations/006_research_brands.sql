-- Research (labs, points per family, first-to-tier records) and the product designer (brands, designs).

-- ---------- Research ----------
ALTER TABLE companies ADD COLUMN research_focus text
  CHECK (research_focus IN ('agri', 'food', 'textiles', 'metals', 'electronics', 'auto', 'luxury', 'energy'));

CREATE TABLE company_research (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  family      text NOT NULL,
  points      int NOT NULL DEFAULT 0 CHECK (points >= 0),
  PRIMARY KEY (company_id, family)
);

-- Who reached each family tier first (the +500 XP innovation bonus).
CREATE TABLE research_firsts (
  family      text NOT NULL,
  tier        int NOT NULL CHECK (tier BETWEEN 1 AND 5),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reached_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family, tier)
);

CREATE TABLE research_log (
  id          bigserial PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  family      text NOT NULL,
  points      int NOT NULL CHECK (points > 0),
  source      text NOT NULL CHECK (source IN ('lab', 'applied')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_log_company ON research_log (company_id, id DESC);

ALTER TABLE xp_events DROP CONSTRAINT xp_events_source_check;
ALTER TABLE xp_events ADD CONSTRAINT xp_events_source_check
  CHECK (source IN ('production', 'contract_sale', 'contract_purchase', 'trade', 'npc_sale', 'seed', 'research'));

-- ---------- Brands & designs ----------
CREATE TABLE brands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  name_key    text NOT NULL,
  logo        int NOT NULL CHECK (logo BETWEEN 0 AND 9),
  reputation  numeric(5, 2) NOT NULL DEFAULT 10 CHECK (reputation BETWEEN 0 AND 100),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX brands_name_unique ON brands (name_key);

-- A design is its own product row (so inventory, exchange, contracts and NPC sales all work on it).
CREATE TABLE designs (
  product_id        text PRIMARY KEY REFERENCES products(id),
  brand_id          uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  template_id       text NOT NULL,
  building_type_id  text NOT NULL REFERENCES building_types(id),
  base_product_id   text NOT NULL REFERENCES products(id),
  tier              text NOT NULL CHECK (tier IN ('basic', 'premium', 'luxury')),
  slots             jsonb NOT NULL,
  materials_cents   bigint NOT NULL CHECK (materials_cents >= 0),
  art               text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX designs_brand ON designs (brand_id);

-- Which design (if any) a building runs instead of its normal recipe.
ALTER TABLE buildings ADD COLUMN design_id text REFERENCES designs(product_id);

-- Daily reputation history, one row per brand per game day.
CREATE TABLE brand_days (
  brand_id    uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  day         int NOT NULL,
  units       int NOT NULL,
  buyers      int NOT NULL,
  reputation  numeric(5, 2) NOT NULL,
  PRIMARY KEY (brand_id, day)
);
