-- Accounts: email + password sign-in. One company per account. Sessions store only a hash of the token
-- and expire after 30 days without use.

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  password_hash  text NOT NULL,
  company_id     uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- Existing sessions held raw tokens; drop them (everyone signs in again) and store hashes from now on.
DELETE FROM sessions;
ALTER TABLE sessions RENAME COLUMN token TO token_hash;
ALTER TABLE sessions ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days';
CREATE INDEX sessions_expires ON sessions (expires_at);
