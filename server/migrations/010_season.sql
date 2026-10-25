-- Season pass: claimed tiers, unlocked cosmetics and the equipped profile title.

CREATE TABLE season_claims (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  season      int NOT NULL,
  tier        int NOT NULL CHECK (tier BETWEEN 1 AND 40),
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, season, tier)
);

CREATE TABLE cosmetics (
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('livery', 'title')),
  name         text NOT NULL,
  season       int NOT NULL,
  unlocked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, kind, name)
);

ALTER TABLE companies ADD COLUMN title text;

ALTER TABLE trophies DROP CONSTRAINT trophies_kind_check;
ALTER TABLE trophies ADD CONSTRAINT trophies_kind_check CHECK (kind IN ('promotion', 'relegation', 'contest', 'checkpoint', 'season'));
