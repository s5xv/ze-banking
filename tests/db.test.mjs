// tests/db.test.mjs - proves the database actually enforces the money rules.
//
//   node tests/db.test.mjs
//
// Runs against the LOCAL D1 (--local), never the remote database. Nothing here
// can touch real customer money.
//
// WHY THIS MATTERS MORE THAN IT LOOKS
// The whole design rests on the claim that certain mistakes are impossible
// because the database refuses them, not because the application remembers to
// check. If the overdraft CHECK does not actually abort a write, then "you
// cannot spend money you do not have" is a comment rather than a guarantee.
//
// Every "should be refused" test below is a rule that protects real money.
//
// NOTE ON MECHANICS: statements go through a temp .sql file rather than
// --command. Passing multi-line SQL as a command line argument gets truncated
// at the first newline on Windows, which produces a confusing
// "incomplete input" error that has nothing to do with the SQL.

import { execSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";

const DB = "ze-bank";
const TMP = "tests/.tmp-test.sql";

let passed = 0;
let failed = 0;

function run(sqlText) {
  writeFileSync(TMP, sqlText, "utf8");
  return execSync(`npx wrangler d1 execute ${DB} --local --file=${TMP}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Run setup SQL. Failure here is fatal, not a test result. */
function setup(sqlText) {
  try {
    run(sqlText);
  } catch (err) {
    console.log("\nSetup step failed, cannot continue:\n" + detail(err) + "\n");
    cleanupTmp();
    process.exit(1);
  }
}

/** A statement that must succeed. */
function ok(name, sqlText) {
  try {
    run(sqlText);
    passed++;
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        expected success, got: ${detail(err)}`);
  }
}

/** A statement the database MUST refuse. These are the important ones. */
function rejects(name, sqlText) {
  try {
    run(sqlText);
    failed++;
    console.log(`  FAIL  ${name}\n        the database ALLOWED this. That is a money bug.`);
  } catch {
    passed++;
  }
}

/** A query whose output must contain some text. */
function contains(name, sqlText, needle) {
  try {
    const out = run(sqlText);
    if (out.includes(needle)) passed++;
    else {
      failed++;
      console.log(`  FAIL  ${name}\n        expected output to contain "${needle}"`);
    }
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        query errored: ${detail(err)}`);
  }
}

function detail(err) {
  const text = String(err.stderr || err.stdout || err.message);
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\[[0-9;]*m/g, "");
  return clean.split("\n").map((l) => l.trim()).filter(Boolean).find((l) => l.includes("ERROR")) ||
    clean.split("\n").map((l) => l.trim()).find(Boolean) ||
    "unknown error";
}

function cleanupTmp() {
  if (existsSync(TMP)) rmSync(TMP);
}

const WIPE = `
DELETE FROM postings;
DELETE FROM entries;
DELETE FROM deposits;
DELETE FROM interest_runs;
DELETE FROM withdrawals;
DELETE FROM scheduled_payments;
DELETE FROM business_tier_charges;
DELETE FROM business_members;
DELETE FROM businesses;
DELETE FROM mc_verifications;
DELETE FROM accounts WHERE id > 3;
DELETE FROM users;
UPDATE accounts SET balance_cents = 0;
`;

// ---------------------------------------------------------------------------
console.log("Applying schema to the local database...");
// ---------------------------------------------------------------------------
try {
  execSync(`npx wrangler d1 execute ${DB} --local --file=schema.sql`, {
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (err) {
  console.log("Could not apply schema.sql:\n" + detail(err));
  process.exit(1);
}

// Migrations may fail if their changes are already in schema.sql. That is
// expected and not a problem, so failures here are ignored deliberately.
for (const f of ["001_verification", "002_bank_funding", "003_business", "004_features"]) {
  try {
    execSync(`npx wrangler d1 execute ${DB} --local --file=migrations/${f}.sql`, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    /* already applied */
  }
}

setup(WIPE);

// ---------------------------------------------------------------------------
console.log("\nSchema");
// ---------------------------------------------------------------------------
for (const t of [
  "users", "accounts", "entries", "postings", "deposits", "withdrawals",
  "interest_runs", "mc_verifications", "businesses", "business_members",
  "business_tier_charges", "scheduled_payments", "settings", "audit_log",
]) {
  contains(`table ${t} exists`, `SELECT name FROM sqlite_master WHERE name='${t}';`, t);
}
contains("internal accounts seeded", `SELECT COUNT(*) AS n FROM accounts WHERE id IN (1,2,3);`, "3");

setup(`
INSERT INTO users (id, discord_id, discord_username, mc_uuid, mc_username, mc_verified_at)
VALUES (100, 'test-discord', 'tester', 'uuid-abc', 'Tester', datetime('now'));
INSERT INTO accounts (id, owner_user_id, kind, label, deposit_code)
VALUES (100, 100, 'checking', 'Test checking', 'aaaaaaaaaaaaaaaa');
`);

// ---------------------------------------------------------------------------
console.log("\nAccount rules");
// ---------------------------------------------------------------------------
rejects("a customer account cannot go negative",
  `UPDATE accounts SET balance_cents = -1 WHERE id = 100;`);

ok("an internal account CAN go negative",
  `UPDATE accounts SET balance_cents = -5000 WHERE id = 1;`);
setup(`UPDATE accounts SET balance_cents = 0 WHERE id = 1;`);

rejects("a customer account must have an owner",
  `INSERT INTO accounts (kind, label) VALUES ('checking', 'orphan');`);

rejects("an unknown account kind is refused",
  `INSERT INTO accounts (owner_user_id, kind) VALUES (100, 'crypto');`);

rejects("an unknown account status is refused",
  `UPDATE accounts SET status = 'melted' WHERE id = 100;`);

rejects("two accounts cannot share a deposit code",
  `INSERT INTO accounts (owner_user_id, kind, deposit_code)
   VALUES (100, 'checking', 'aaaaaaaaaaaaaaaa');`);

// ---------------------------------------------------------------------------
console.log("\nLedger rules");
// ---------------------------------------------------------------------------
ok("a balanced entry can be written",
  `INSERT INTO entries (id, kind, idempotency_key) VALUES (900, 'deposit', 'test-key-1');`);

rejects("an idempotency key cannot be reused",
  `INSERT INTO entries (kind, idempotency_key) VALUES ('deposit', 'test-key-1');`);

rejects("an entry needs a recognised kind",
  `INSERT INTO entries (kind, idempotency_key) VALUES ('smuggling', 'test-key-2');`);

rejects("a posting cannot be for zero",
  `INSERT INTO postings (entry_id, account_id, amount_cents) VALUES (900, 100, 0);`);

ok("postings can be written",
  `INSERT INTO postings (entry_id, account_id, amount_cents)
   VALUES (900, 100, 5000), (900, 1, -5000);`);

contains("the entry balances to zero",
  `SELECT SUM(amount_cents) AS total FROM postings WHERE entry_id = 900;`, "0");

// ---------------------------------------------------------------------------
console.log("\nDouble credit protection");
// ---------------------------------------------------------------------------
setup(`INSERT INTO deposits (treasury_posting_id, account_id, amount_cents)
       VALUES ('posting-1', 100, 5000);`);

rejects("the same Treasury posting cannot be credited twice",
  `INSERT INTO deposits (treasury_posting_id, account_id, amount_cents)
   VALUES ('posting-1', 100, 5000);`);

rejects("a deposit cannot be for a negative amount",
  `INSERT INTO deposits (treasury_posting_id, account_id, amount_cents)
   VALUES ('posting-2', 100, -5000);`);

setup(`INSERT INTO interest_runs (account_id, period, basis_cents, rate_bps, amount_cents)
       VALUES (100, '2026-07', 100000, 200, 2000);`);

rejects("interest cannot be paid twice for the same month",
  `INSERT INTO interest_runs (account_id, period, basis_cents, rate_bps, amount_cents)
   VALUES (100, '2026-07', 100000, 200, 2000);`);

ok("interest CAN be paid for a different month",
  `INSERT INTO interest_runs (account_id, period, basis_cents, rate_bps, amount_cents)
   VALUES (100, '2026-08', 100000, 200, 2000);`);

setup(`INSERT INTO withdrawals (account_id, amount_cents, idempotency_key)
       VALUES (100, 100, 'w1');`);

rejects("a withdrawal idempotency key cannot be reused",
  `INSERT INTO withdrawals (account_id, amount_cents, idempotency_key)
   VALUES (100, 100, 'w1');`);

rejects("an unknown withdrawal status is refused",
  `INSERT INTO withdrawals (account_id, amount_cents, idempotency_key, status)
   VALUES (100, 100, 'w2', 'vanished');`);

// ---------------------------------------------------------------------------
console.log("\nVerification");
// ---------------------------------------------------------------------------
setup(`INSERT INTO mc_verifications (user_id, mc_uuid, mc_username, code, amount_cents, expires_at)
       VALUES (100, 'uuid-abc', 'Tester', 'VERIFY-AAAAAAAAAAAA', 100, datetime('now','+1 hour'));`);

rejects("a verification code cannot be reused",
  `INSERT INTO mc_verifications (user_id, mc_uuid, mc_username, code, amount_cents, expires_at)
   VALUES (100, 'uuid-abc', 'Tester', 'VERIFY-AAAAAAAAAAAA', 100, datetime('now','+1 hour'));`);

rejects("one Minecraft account cannot belong to two users",
  `INSERT INTO users (discord_id, discord_username, mc_uuid)
   VALUES ('other', 'other', 'uuid-abc');`);

rejects("an unknown verification status is refused",
  `UPDATE mc_verifications SET status = 'maybe' WHERE id = 1;`);

// ---------------------------------------------------------------------------
console.log("\nBusiness rules");
// ---------------------------------------------------------------------------
setup(`INSERT INTO businesses (id, firm_name, display_name, owner_user_id)
       VALUES (100, 'TestFirm', 'Test Firm', 100);`);

rejects("a firm cannot be registered twice",
  `INSERT INTO businesses (firm_name, display_name, owner_user_id)
   VALUES ('TestFirm', 'Duplicate', 100);`);

rejects("an unknown tier is refused",
  `UPDATE businesses SET tier = 'diamond' WHERE id = 100;`);

setup(`INSERT INTO business_members (business_id, user_id, role) VALUES (100, 100, 'owner');`);

rejects("a person cannot join the same company twice",
  `INSERT INTO business_members (business_id, user_id, role) VALUES (100, 100, 'employee');`);

rejects("an unknown company role is refused",
  `INSERT INTO business_members (business_id, user_id, role) VALUES (100, 1, 'ceo');`);

setup(`INSERT INTO business_tier_charges (business_id, period, tier, amount_cents)
       VALUES (100, '2026-07', 'silver', 100000);`);

rejects("a company cannot be billed twice for one month",
  `INSERT INTO business_tier_charges (business_id, period, tier, amount_cents)
   VALUES (100, '2026-07', 'silver', 100000);`);

// ---------------------------------------------------------------------------
console.log("\nScheduled payments");
// ---------------------------------------------------------------------------
rejects("a scheduled payment cannot be for zero",
  `INSERT INTO scheduled_payments (from_account_id, to_account_id, amount_cents, next_run)
   VALUES (100, 1, 0, date('now'));`);

rejects("an unknown frequency is refused",
  `INSERT INTO scheduled_payments (from_account_id, to_account_id, amount_cents, next_run, frequency)
   VALUES (100, 1, 500, date('now'), 'hourly');`);

ok("a valid scheduled payment is accepted",
  `INSERT INTO scheduled_payments (from_account_id, to_account_id, amount_cents, next_run, frequency)
   VALUES (100, 1, 500, date('now'), 'monthly');`);

// ---------------------------------------------------------------------------
setup(WIPE);
cleanupTmp();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(
    "\nA failure here is not cosmetic. Each of these is a rule that stops money\n" +
      "being invented, lost, or paid twice."
  );
}
process.exit(failed === 0 ? 0 : 1);
