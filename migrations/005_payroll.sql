-- Migration 005 - payroll and spending alerts
-- ===========================================================================
--   npx wrangler d1 execute ze-bank --remote --file=migrations/005_payroll.sql
--
-- Safe to run once. The ALTERs will fail on a second run, which is expected.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- PAYROLL
-- One row per employee per company: what they are paid each month.
--
-- Payments are internal transfers between accounts we control, so payroll
-- never touches the Treasury and cannot half complete against a rate limit.
-- That is the main reason wages are paid into Z&E accounts rather than pushed
-- out to Minecraft accounts directly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payroll (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id  INTEGER NOT NULL REFERENCES businesses(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_id, user_id),
  CHECK (amount_cents > 0),
  CHECK (active IN (0,1))
);

-- ---------------------------------------------------------------------------
-- PAYROLL RUNS
-- UNIQUE(business_id, user_id, period) is the double payment guard, the same
-- pattern as interest and tier billing. Somebody being paid their salary twice
-- in one month is exactly the class of bug these constraints exist to prevent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payroll_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id  INTEGER NOT NULL REFERENCES businesses(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  period       TEXT NOT NULL,              -- 'YYYY-MM'
  amount_cents INTEGER NOT NULL,
  entry_id     INTEGER REFERENCES entries(id),
  status       TEXT NOT NULL DEFAULT 'paid',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_id, user_id, period),
  CHECK (status IN ('paid','failed'))
);

CREATE INDEX IF NOT EXISTS idx_payroll_biz  ON payroll(business_id, active);
CREATE INDEX IF NOT EXISTS idx_payrun_biz   ON payroll_runs(business_id, period);

-- ---------------------------------------------------------------------------
-- SPENDING ALERTS
-- Deliberately stored as thresholds on the account and evaluated when a page
-- is rendered, rather than as a notifications table written by a background
-- job. Derived state cannot drift out of sync with the balance it describes,
-- and there is no queue to get stuck.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN alert_below_cents INTEGER;
ALTER TABLE accounts ADD COLUMN alert_txn_over_cents INTEGER;
