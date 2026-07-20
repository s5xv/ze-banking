-- Migration 006 - approvals, joint accounts, direct debits, business webhooks
-- ===========================================================================
--   npx wrangler d1 execute ze-bank --remote --file=migrations/006_approvals.sql
--
-- The ALTERs fail on a second run. That is expected.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- PENDING TRANSFERS
--
-- One mechanism covering two requirements that turn out to be the same thing:
--
--   * savings withdrawals needing an admin to accept them
--   * joint accounts needing 2 of 3 owners to sign above a threshold
--
-- Both are "money that has been requested but not yet moved, waiting on
-- signatures". Building them separately would mean two half tested approval
-- systems instead of one.
--
-- CRITICAL: money does NOT leave the account when a request is made. The
-- balance is checked again at execution time, so a pending request cannot be
-- used to reserve money the account no longer has. The alternative, debiting
-- on request, would mean a rejected request has to be refunded, and refunds
-- are where double spends live.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_transfers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_account_id INTEGER NOT NULL REFERENCES accounts(id),
  to_account_id   INTEGER REFERENCES accounts(id),
  kind            TEXT NOT NULL,          -- 'withdrawal' | 'transfer'
  amount_cents    INTEGER NOT NULL,
  memo            TEXT,
  requested_by    INTEGER NOT NULL REFERENCES users(id),
  signatures_needed INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending',
  decided_by      INTEGER REFERENCES users(id),
  decided_at      TEXT,
  reject_reason   TEXT,
  entry_id        INTEGER REFERENCES entries(id),
  withdrawal_id   INTEGER REFERENCES withdrawals(id),
  expires_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (amount_cents > 0),
  CHECK (kind IN ('withdrawal','transfer')),
  CHECK (status IN ('pending','approved','rejected','expired','executed'))
);

-- Who has signed. UNIQUE stops one person signing twice to reach a threshold
-- of two on their own.
CREATE TABLE IF NOT EXISTS pending_signatures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pending_id INTEGER NOT NULL REFERENCES pending_transfers(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  signed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (pending_id, user_id)
);

-- ---------------------------------------------------------------------------
-- JOINT ACCOUNTS
-- Signers on an account, and the threshold above which their signatures are
-- required. Below the threshold the account behaves normally.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_signers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  added_by   INTEGER REFERENCES users(id),
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, user_id)
);

-- requires_approval: staff must accept any withdrawal from this account.
--   Set on savings accounts, as specified.
-- joint_threshold_cents: amounts at or above this need signatures.
-- signatures_required: how many, for a joint account.
ALTER TABLE accounts ADD COLUMN requires_approval INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN joint_threshold_cents INTEGER;
ALTER TABLE accounts ADD COLUMN signatures_required INTEGER NOT NULL DEFAULT 1;

-- Existing savings accounts get approval turned on, matching the spec.
UPDATE accounts SET requires_approval = 1
 WHERE kind = 'savings' AND cd_matures_at IS NULL;

-- ---------------------------------------------------------------------------
-- DIRECT DEBITS
-- A mandate letting someone else pull an agreed amount. Unlike a scheduled
-- payment, the RECIPIENT triggers it, which is why it needs a mandate the
-- payer can revoke at any time and a per pull ceiling they set.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS direct_debits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_account_id INTEGER NOT NULL REFERENCES accounts(id),
  to_account_id   INTEGER NOT NULL REFERENCES accounts(id),
  business_id     INTEGER REFERENCES businesses(id),
  reference       TEXT,
  max_cents       INTEGER NOT NULL,
  authorised_by   INTEGER NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'active',
  last_pulled_at  TEXT,
  total_pulled_cents INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (max_cents > 0),
  CHECK (status IN ('active','revoked'))
);

CREATE TABLE IF NOT EXISTS direct_debit_pulls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  direct_debit_id INTEGER NOT NULL REFERENCES direct_debits(id),
  amount_cents   INTEGER NOT NULL,
  entry_id       INTEGER REFERENCES entries(id),
  reference      TEXT NOT NULL UNIQUE,   -- idempotency, supplied by the puller
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- BUSINESS WEBHOOKS - the Platinum "webhook integration" perk.
-- Fires when money moves on a company account.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  failures    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_transfers(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_pending_from   ON pending_transfers(from_account_id);
CREATE INDEX IF NOT EXISTS idx_signers_acct   ON account_signers(account_id);
CREATE INDEX IF NOT EXISTS idx_signers_user   ON account_signers(user_id);
CREATE INDEX IF NOT EXISTS idx_dd_from        ON direct_debits(from_account_id, status);
CREATE INDEX IF NOT EXISTS idx_dd_to          ON direct_debits(to_account_id, status);
CREATE INDEX IF NOT EXISTS idx_bizhooks       ON business_webhooks(business_id, active);
