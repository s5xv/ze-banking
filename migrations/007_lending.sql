-- Migration 007 - credit and loans
-- ===========================================================================
--   npx wrangler d1 execute ze-bank --remote --file=migrations/007_lending.sql
--
-- Safe to run once. The whole lending system ships DORMANT: it does nothing
-- until an admin lowers the reserve ratio below 100%, which is what permits the
-- bank to lend at all. See lending.js for how that gate works.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- LOANS
-- A loan moves money from bank equity to the borrower, and records a debt they
-- owe back. Interest accrues monthly on the outstanding balance.
--
-- A loan is only ADVANCED once the contract is signed. Until then it is a
-- pending offer with a signing link.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loans (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  borrower_user_id  INTEGER NOT NULL REFERENCES users(id),
  business_id       INTEGER REFERENCES businesses(id),
  to_account_id     INTEGER REFERENCES accounts(id),
  principal_cents   INTEGER NOT NULL,
  rate_bps          INTEGER NOT NULL,          -- monthly, fixed at approval
  term_months       INTEGER NOT NULL,
  outstanding_cents INTEGER NOT NULL DEFAULT 0,-- principal + accrued interest - repaid
  status            TEXT NOT NULL DEFAULT 'offered',
  sign_token        TEXT UNIQUE,               -- the link the borrower signs at
  contract_text     TEXT,
  offered_by        INTEGER REFERENCES users(id),
  signed_at         TEXT,
  advanced_at       TEXT,
  closed_at         TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (principal_cents > 0),
  CHECK (status IN ('offered','signed','active','repaid','defaulted','cancelled'))
);

-- Repayments and interest charges against a loan. One row per event.
CREATE TABLE IF NOT EXISTS loan_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id      INTEGER NOT NULL REFERENCES loans(id),
  kind         TEXT NOT NULL,                  -- 'advance'|'interest'|'repayment'
  amount_cents INTEGER NOT NULL,
  period       TEXT,                           -- for interest, 'YYYY-MM'
  entry_id     INTEGER REFERENCES entries(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (kind IN ('advance','interest','repayment')),
  -- One interest charge per loan per month, the same guard as savings interest.
  UNIQUE (loan_id, kind, period)
);

-- ---------------------------------------------------------------------------
-- CREDIT CARDS
-- A revolving line: the holder can spend up to a limit, carries a balance, and
-- is charged interest monthly on what they owe. Modelled as an account that is
-- allowed to go negative, with a floor at -limit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_cards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  limit_cents   INTEGER NOT NULL,
  rate_bps      INTEGER NOT NULL,              -- monthly
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (limit_cents > 0),
  CHECK (status IN ('active','frozen','closed'))
);

CREATE TABLE IF NOT EXISTS credit_interest_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id      INTEGER NOT NULL REFERENCES credit_cards(id),
  period       TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  entry_id     INTEGER REFERENCES entries(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (card_id, period)
);

CREATE INDEX IF NOT EXISTS idx_loans_borrower ON loans(borrower_user_id, status);
CREATE INDEX IF NOT EXISTS idx_loans_status   ON loans(status);
CREATE INDEX IF NOT EXISTS idx_loanev_loan    ON loan_events(loan_id);
CREATE INDEX IF NOT EXISTS idx_cards_user     ON credit_cards(user_id, status);

-- Standard rates, adjustable in admin settings. Tier discounts come off these.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('loan_rate_bps',   '400'),   -- 4.00% monthly standard
  ('credit_rate_bps', '500'),   -- 5.00% monthly, as specified
  ('lending_enabled', 'auto');  -- 'auto' follows the reserve ratio; 'off' forces off
