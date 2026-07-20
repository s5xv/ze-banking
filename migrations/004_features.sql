-- Migration 004 - fixed deposits, savings goals, scheduled payments
-- ===========================================================================
--   npx wrangler d1 execute ze-bank --remote --file=migrations/004_features.sql
--
-- Safe to run twice. D1 runs a file as one unit, so a single failing statement
-- rolls the whole thing back.
--
-- DESIGN NOTE - why a CD is not its own account kind:
-- accounts has a CHECK constraint listing valid kinds, and SQLite cannot alter
-- a CHECK without rebuilding the table. Rebuilding the table that holds every
-- customer balance, on a live bank, to add a label is not a trade worth making.
--
-- So a CD is a savings account with a maturity date. cd_matures_at being set
-- is what makes it one:
--   * money cannot leave until that date
--   * interest comes from the account's own interest_bps, because a fixed
--     deposit's rate is fixed when it is opened
--
-- The interest engine already prefers a non-zero interest_bps over the global
-- savings rate, so CDs need no special case there.
-- ===========================================================================

ALTER TABLE accounts ADD COLUMN cd_matures_at TEXT;
ALTER TABLE accounts ADD COLUMN cd_term_months INTEGER;
ALTER TABLE accounts ADD COLUMN cd_opened_cents INTEGER;

-- Savings goals. Display only, no money mechanics, so nothing can go wrong
-- here beyond a wrong number on a progress bar.
ALTER TABLE accounts ADD COLUMN goal_cents INTEGER;
ALTER TABLE accounts ADD COLUMN goal_label TEXT;

CREATE INDEX IF NOT EXISTS idx_accounts_cd ON accounts(cd_matures_at);

-- ---------------------------------------------------------------------------
-- SCHEDULED PAYMENTS
-- "On this day, pay this person this much." Runs internally between accounts,
-- so it never touches the Treasury and cannot fail halfway.
--
-- next_run is a date. Each execution is keyed sched:<id>:<date>, so the runner
-- can fire repeatedly without paying twice, exactly like interest.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduled_payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_account_id INTEGER NOT NULL REFERENCES accounts(id),
  to_account_id   INTEGER NOT NULL REFERENCES accounts(id),
  created_by      INTEGER REFERENCES users(id),
  amount_cents    INTEGER NOT NULL,
  memo            TEXT,
  frequency       TEXT NOT NULL DEFAULT 'monthly',
  next_run        TEXT NOT NULL,
  last_run        TEXT,
  last_status     TEXT,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (amount_cents > 0),
  CHECK (frequency IN ('weekly','monthly')),
  CHECK (status IN ('active','paused','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_sched_due  ON scheduled_payments(status, next_run);
CREATE INDEX IF NOT EXISTS idx_sched_from ON scheduled_payments(from_account_id);

-- Base fixed deposit rate, monthly basis points. 300 = 3.00% as specified.
-- Business tiers add a bonus at the moment a CD is opened.
INSERT OR IGNORE INTO settings (key, value) VALUES ('cd_rate_bps', '300');
