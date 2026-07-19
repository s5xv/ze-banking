-- Z&E Bank — ledger schema
-- ===========================================================================
-- Run once:
--   npx wrangler d1 execute ze-bank --remote --file=schema.sql
--
-- DESIGN NOTE — why so many CHECK constraints:
-- Money rules enforced in application code are only as durable as the next
-- person to edit that code. Rules enforced by the database hold even when the
-- application is wrong. Everything that would let money be invented, lost, or
-- double-spent is a constraint here, not an `if` statement in JS.
--
-- ALL AMOUNTS ARE INTEGER CENTS. Never store a decimal or a float. The
-- Treasury API returns decimal strings precisely because floats corrupt money.
-- ===========================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- USERS — Discord identity, with a *proven* Minecraft link.
-- mc_verified_at is only set after the player sends a verification payment
-- carrying a one-time code. A self-typed username is never trusted, because it
-- decides where withdrawals go.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id        TEXT NOT NULL UNIQUE,
  discord_username  TEXT,
  discord_avatar    TEXT,
  mc_uuid           TEXT UNIQUE,
  mc_username       TEXT,
  mc_verified_at    TEXT,
  role              TEXT NOT NULL DEFAULT 'customer',
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at     TEXT,
  CHECK (role   IN ('customer','staff','admin')),
  CHECK (status IN ('active','suspended'))
);

-- ---------------------------------------------------------------------------
-- ACCOUNTS
--
-- kind:
--   checking / savings   — customer money (a LIABILITY of the bank)
--   internal_pool        — mirrors the real Treasury firm account (ASSET)
--   internal_equity      — the bank's own capital; absorbs interest cost
--   internal_suspense    — money in flight (a withdrawal sent but unconfirmed)
--
-- balance_cents is a cached aggregate. Postings are the source of truth; this
-- column exists so reads don't sum the whole postings table, and it is ALWAYS
-- written in the same atomic batch as its postings. Reconciliation re-derives
-- it and shouts if they disagree.
--
-- The overdraft CHECK is the real protection against spending money that isn't
-- there — it fails the whole batch at the database level, whatever the
-- application believed the balance was a moment earlier.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id  INTEGER REFERENCES users(id),
  kind           TEXT NOT NULL,
  label          TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  balance_cents  INTEGER NOT NULL DEFAULT 0,
  -- Permanent per-account code the customer puts in the /pay memo. Reused
  -- forever, so depositing is "pay this code again" rather than "come back to
  -- the site and generate a new one each time".
  deposit_code   TEXT UNIQUE,
  -- Only internal bookkeeping accounts (and later, credit) may go negative.
  allow_negative INTEGER NOT NULL DEFAULT 0,
  interest_bps   INTEGER NOT NULL DEFAULT 0,   -- monthly rate, basis points
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at      TEXT,
  CHECK (kind   IN ('checking','savings','internal_pool','internal_equity','internal_suspense')),
  CHECK (status IN ('active','frozen','closed')),
  CHECK (allow_negative IN (0,1)),
  CHECK (allow_negative = 1 OR balance_cents >= 0),
  -- Customer accounts must have an owner; internal accounts must not.
  CHECK (
    (kind IN ('checking','savings') AND owner_user_id IS NOT NULL)
    OR
    (kind LIKE 'internal_%' AND owner_user_id IS NULL)
  )
);

-- ---------------------------------------------------------------------------
-- ENTRIES — one journal header per money movement.
--
-- idempotency_key is UNIQUE and REQUIRED. This single constraint is what makes
-- every operation in the system safe to retry: a duplicated request fails at
-- the database instead of moving money a second time. Never generate it
-- randomly at the point of insert — derive it from the thing being recorded
-- (treasury posting id, withdrawal id, account+period, ...).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  memo            TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (kind IN ('deposit','withdrawal','withdrawal_reversal','transfer',
                  'interest','adjustment','fee','opening'))
);

-- ---------------------------------------------------------------------------
-- POSTINGS — the double-entry legs.
--
-- INVARIANT: for any entry_id, SUM(amount_cents) = 0.
-- SQLite can't express a cross-row constraint, so it's asserted in ledger.js
-- before the batch is built AND re-checked by the reconciliation job. A
-- zero-amount posting is meaningless, so it's rejected here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS postings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id     INTEGER NOT NULL REFERENCES entries(id),
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  amount_cents INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (amount_cents <> 0)
);

-- ---------------------------------------------------------------------------
-- DEPOSITS — real money arriving in the Treasury pool.
--
-- treasury_posting_id is the Treasury's per-account `postingId`, and it is
-- UNIQUE. That is what lets the webhook and the cursor-feed poller both run
-- without ever crediting the same deposit twice.
--
-- NOT `txnId` — that is shared by both sides of a transfer and would collide.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deposits (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  treasury_posting_id TEXT NOT NULL UNIQUE,
  treasury_txn_id     TEXT,
  account_id          INTEGER REFERENCES accounts(id),
  entry_id            INTEGER REFERENCES entries(id),
  amount_cents        INTEGER NOT NULL,
  memo                TEXT,
  payer_uuid          TEXT,
  payer_name          TEXT,
  status              TEXT NOT NULL DEFAULT 'credited',
  source              TEXT NOT NULL DEFAULT 'feed',
  settled_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (amount_cents > 0),
  CHECK (status IN ('credited','unmatched')),
  CHECK (source IN ('feed','webhook','manual')),
  -- 'unmatched' means real money arrived that we couldn't attribute to an
  -- account. It is parked in suspense and surfaced to an admin. It is never
  -- silently dropped.
  CHECK (status = 'unmatched' OR account_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- WITHDRAWALS — real money leaving. The most dangerous path in the system.
--
-- The ledger is debited BEFORE the Treasury call. That deliberately chooses
-- "stuck pending" (recoverable) over "paid twice" (money gone).
--
-- status:
--   pending       ledger debited, Treasury call not yet confirmed
--   sent          Treasury confirmed
--   failed        Treasury rejected; ledger entry reversed
--   needs_review  unknown outcome (timeout/5xx). NEVER retry blindly —
--                 re-send the SAME idempotency_key, or confirm via the feed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS withdrawals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id       INTEGER NOT NULL REFERENCES accounts(id),
  requested_by     INTEGER REFERENCES users(id),
  amount_cents     INTEGER NOT NULL,
  to_player_uuid   TEXT,
  to_player_name   TEXT,
  idempotency_key  TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'pending',
  entry_id         INTEGER REFERENCES entries(id),
  reversal_entry_id INTEGER REFERENCES entries(id),
  treasury_txn_id  TEXT,
  failure_reason   TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at       TEXT,
  CHECK (amount_cents > 0),
  CHECK (status IN ('pending','sent','failed','needs_review'))
);

-- ---------------------------------------------------------------------------
-- INTEREST RUNS — one row per account per period, enforced by UNIQUE.
--
-- This constraint IS the double-credit protection. The insert is attempted
-- first; if it is rejected, that month is already paid and the run skips.
-- Deliberately not "check then write" — that races.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interest_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  period        TEXT NOT NULL,              -- 'YYYY-MM'
  basis_cents   INTEGER NOT NULL,           -- balance interest was computed on
  rate_bps      INTEGER NOT NULL,
  amount_cents  INTEGER NOT NULL,
  entry_id      INTEGER REFERENCES entries(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, period)
);

-- ---------------------------------------------------------------------------
-- MC VERIFICATIONS — proving a user controls the Minecraft account they claim.
--
-- The user names an account, we generate a code, they send a small payment
-- carrying that code. The proof is NOT the code (anyone could type it) — it is
-- that the payment ARRIVED FROM the claimed uuid. `initiatorUuid` on the
-- Treasury posting must match `mc_uuid` here, or the attempt is rejected.
--
-- Without this, anyone could claim any username and withdraw to it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mc_verifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  mc_uuid      TEXT NOT NULL,
  mc_username  TEXT NOT NULL,
  code         TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  expires_at   TEXT NOT NULL,
  verified_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('pending','verified','expired','rejected'))
);
CREATE INDEX IF NOT EXISTS idx_mcver_user ON mc_verifications(user_id, status);

-- ---------------------------------------------------------------------------
-- LEDGER CURSOR — position in the Treasury transaction feed.
-- Single row (id = 1). Lets ingestion resume exactly where it stopped instead
-- of re-scanning a fixed window and eventually missing transactions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_cursor (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  cursor      INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO ledger_cursor (id, cursor) VALUES (1, 0);

-- ---------------------------------------------------------------------------
-- RECONCILIATION — the record of whether the books balance.
-- drift_cents <> 0 means money is missing or invented. Auto-processing of
-- withdrawals halts until an admin acknowledges.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  treasury_cents      INTEGER NOT NULL,     -- real pool balance
  ledger_cents        INTEGER NOT NULL,     -- what our books say it should be
  liabilities_cents   INTEGER NOT NULL,     -- owed to customers
  drift_cents         INTEGER NOT NULL,
  balance_mismatches  INTEGER NOT NULL DEFAULT 0,
  unbalanced_entries  INTEGER NOT NULL DEFAULT 0,
  acknowledged_by     INTEGER REFERENCES users(id),
  acknowledged_at     TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- AUDIT LOG — every privileged action. Append-only by convention.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- SETTINGS — runtime config that must change without a redeploy.
-- reserve_ratio_bps default 10000 = 100% = fully reserved. The bank cannot
-- lend customer deposits until V1 explicitly lowers this, and lowering it is
-- an audited action.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('reserve_ratio_bps', '10000'),
  ('savings_rate_bps',  '200'),
  ('withdrawals_paused','0');

-- ---------------------------------------------------------------------------
-- The three internal accounts. Created here so they always exist with known
-- ids and can never be duplicated.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO accounts (id, kind, label, allow_negative) VALUES
  (1, 'internal_pool',     'Treasury pool (real funds)',  1),
  (2, 'internal_equity',   'Bank equity',                 1),
  (3, 'internal_suspense', 'In flight / unattributed',    1);

CREATE INDEX IF NOT EXISTS idx_accounts_owner    ON accounts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_postings_account  ON postings(account_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_postings_entry    ON postings(entry_id);
CREATE INDEX IF NOT EXISTS idx_entries_created   ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_account  ON deposits(account_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_withdraw_status   ON withdrawals(status, id);
CREATE INDEX IF NOT EXISTS idx_withdraw_account  ON withdrawals(account_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_users_discord     ON users(discord_id);
CREATE INDEX IF NOT EXISTS idx_users_mc          ON users(mc_uuid);
CREATE INDEX IF NOT EXISTS idx_audit_created     ON audit_log(created_at DESC);
