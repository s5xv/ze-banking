-- Migration 001 - verification table + deposit code index
-- ===========================================================================
--   npx wrangler d1 execute ze-bank --remote --file=migrations/001_verification.sql
--
-- IMPORTANT: D1 runs a file as ONE unit. If any statement errors, the entire
-- file is rolled back - including statements that would have succeeded. So
-- every statement here is written to be safe to run repeatedly:
--   CREATE TABLE / INDEX ... IF NOT EXISTS
--   UPDATE with a WHERE that matches nothing on a second run
--
-- Deliberately NO `ALTER TABLE accounts ADD COLUMN deposit_code` - current
-- schema.sql already declares that column, so the ALTER fails with "duplicate
-- column name" and takes the rest of the migration down with it. That is
-- exactly what happened the first time.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Proving a user controls the Minecraft account they claim.
-- The code is not the proof - the payment arriving FROM the claimed uuid is.
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

-- Multiple NULLs are allowed in a SQLite UNIQUE index, so the three internal
-- accounts (which have no deposit code) don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_deposit_code ON accounts(deposit_code);

-- Backfill any customer account created before deposit codes existed.
-- hex(randomblob(8)) produces 16 hex chars - the same shape as
-- generateDepositCode() in ledger.js, so both sources are interchangeable.
UPDATE accounts
   SET deposit_code = lower(hex(randomblob(8)))
 WHERE deposit_code IS NULL
   AND kind IN ('checking','savings');
