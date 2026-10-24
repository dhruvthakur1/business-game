-- Weekly leagues and contests.

ALTER TABLE companies ADD COLUMN league_tier text NOT NULL DEFAULT 'Bronze'
  CHECK (league_tier IN ('Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Tycoon'));

-- Value a collected job added (output − inputs at base prices): the Industry League metric.
ALTER TABLE production_jobs ADD COLUMN value_add_cents bigint NOT NULL DEFAULT 0;
CREATE INDEX production_jobs_collected ON production_jobs (collected_at) WHERE state = 'collected';

-- NPC sales with quality, for quality- and harvest-based contests.
CREATE TABLE npc_sale_log (
  id              bigserial PRIMARY KEY,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id      text NOT NULL REFERENCES products(id),
  quality         smallint NOT NULL,
  qty             bigint NOT NULL,
  proceeds_cents  bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX npc_sale_log_company ON npc_sale_log (company_id, created_at);

CREATE TABLE league_weeks (
  week        int PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  closed_at   timestamptz,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  contests    text[] NOT NULL
);

CREATE TABLE league_groups (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week      int NOT NULL REFERENCES league_weeks(week),
  division  text NOT NULL,
  tier      text NOT NULL,
  group_no  int NOT NULL,
  UNIQUE (week, division, tier, group_no)
);

CREATE TABLE league_members (
  week                  int NOT NULL REFERENCES league_weeks(week),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  group_id              uuid NOT NULL REFERENCES league_groups(id),
  division              text NOT NULL,
  tier                  text NOT NULL,
  start_net_worth_cents bigint NOT NULL,
  joined_at             timestamptz NOT NULL DEFAULT now(),
  -- Filled in when the week closes.
  value_add_cents       bigint,
  points                int,
  final_rank            int,
  outcome               text CHECK (outcome IN ('promoted', 'relegated', 'stayed')),
  op_flow_cents         bigint,
  prize_cents           bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (week, company_id)
);
CREATE INDEX league_members_group ON league_members (group_id);

CREATE TABLE contest_results (
  week          int NOT NULL REFERENCES league_weeks(week),
  contest_id    text NOT NULL,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  group_id      uuid NOT NULL REFERENCES league_groups(id),
  division      text NOT NULL,
  metric        double precision NOT NULL,
  points        int NOT NULL,
  rank          int NOT NULL,
  eligible      boolean NOT NULL,
  reward        text,
  prize_cents   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (week, contest_id, company_id)
);

CREATE TABLE trophies (
  id          bigserial PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  week        int NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('promotion', 'relegation', 'contest', 'checkpoint')),
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trophies_company ON trophies (company_id, id DESC);
