-- Migration 003 - business accounts and tiers
-- ===========================================================================
--   npx wrangler d1 execute ze-bank --remote --file=migrations/003_business.sql
--
-- Every statement is safe to run twice. D1 runs a file as one unit, so a
-- single failing statement rolls back the whole migration.
--
-- DESIGN NOTE - why business accounts are still kind='checking':
-- The accounts table has a CHECK constraint tying kind to ownership, and
-- SQLite cannot alter a CHECK without rebuilding the table. Rather than
-- rebuild a live ledger table (which would mean copying every row of the
-- thing that holds everyone's money), a business account is an ordinary
-- checking account that also carries owner_business_id. The owning user is
-- still recorded, so the existing constraint is satisfied unchanged.
-- Anything that lists personal accounts filters on owner_business_id IS NULL.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- BUSINESSES
-- firm_name is the DemocracyCraft firm this represents. It is verified against
-- the Treasury when the business is created, so a business cannot claim a firm
-- that does not exist.
--
-- paid_until drives whether tier perks are active. It is extended by the
-- monthly billing run, not set by hand.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS businesses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_name      TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  owner_user_id  INTEGER NOT NULL REFERENCES users(id),
  tier           TEXT NOT NULL DEFAULT 'silver',
  logo_url       TEXT,
  public_profile INTEGER NOT NULL DEFAULT 0,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  paid_until     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (tier IN ('silver','gold','platinum')),
  CHECK (status IN ('active','overdue','suspended','closed')),
  CHECK (public_profile IN (0,1))
);

-- ---------------------------------------------------------------------------
-- MEMBERS
-- Kept in our own table rather than mirrored from DemocracyCraft. The Treasury
-- API only exposes the employee list of the firm the API key belongs to, so we
-- cannot read another firm's roster even if we wanted to. Owners manage this
-- list here, and that limitation is stated in the UI.
--
-- role: owner   - full control, can bill, add members, change tier
--       manager - can move money, cannot change tier or members
--       employee - appears on payroll, no banking rights
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_members (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id  INTEGER NOT NULL REFERENCES businesses(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  role         TEXT NOT NULL DEFAULT 'employee',
  added_by     INTEGER REFERENCES users(id),
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_id, user_id),
  CHECK (role IN ('owner','manager','employee'))
);

-- ---------------------------------------------------------------------------
-- TIER CHARGES
-- UNIQUE(business_id, period) is the double billing guard, the same pattern
-- used for interest. A business is charged once per month no matter how often
-- the billing run fires.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_tier_charges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id  INTEGER NOT NULL REFERENCES businesses(id),
  period       TEXT NOT NULL,               -- 'YYYY-MM'
  tier         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  entry_id     INTEGER REFERENCES entries(id),
  status       TEXT NOT NULL DEFAULT 'paid',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_id, period),
  CHECK (status IN ('paid','failed'))
);

-- Link an account to a business. Plain column, no UNIQUE, so ALTER works.
ALTER TABLE accounts ADD COLUMN owner_business_id INTEGER REFERENCES businesses(id);

CREATE INDEX IF NOT EXISTS idx_accounts_business  ON accounts(owner_business_id);
CREATE INDEX IF NOT EXISTS idx_bizmembers_biz     ON business_members(business_id);
CREATE INDEX IF NOT EXISTS idx_bizmembers_user    ON business_members(user_id);
CREATE INDEX IF NOT EXISTS idx_businesses_owner   ON businesses(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_tiercharges_biz    ON business_tier_charges(business_id, period);
