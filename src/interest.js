// interest.js - monthly interest on savings accounts.
// ===========================================================================
// TWO THINGS THIS FILE HAS TO GET RIGHT, BOTH OF WHICH CREATE MONEY IF WRONG.
//
// 1. NEVER PAY TWICE.
//    The guard is postEntry's idempotency key, which is deterministic:
//        interest:<accountId>:<period>
//    entries.idempotency_key is UNIQUE, so a second attempt for the same
//    account and month cannot post, no matter how many times the cron fires,
//    overlaps itself, or gets retried. The interest_runs row is a report of
//    what happened, not the lock. Locks live in the database.
//
// 2. PAY ON THE RIGHT BASIS.
//    Interest is calculated on the account's balance at the START of the
//    period being paid, not its balance right now. If it paid on the current
//    balance, anyone could deposit a large sum on the last day of the month
//    and collect a full month of interest on money the bank held for hours.
//    At 2% monthly that is a free 2% for anyone who noticed, repeatedly.
//
//    Opening balance is derived as:
//        current balance - (everything posted since the period began)
//
// Interest is funded from bank equity. It is a real cost, so equity falls by
// exactly what customers gain, and it shows on the admin dashboard against
// capital put in.
// ===========================================================================

import * as ledger from "./ledger.js";
import { interestCents, assertCents } from "./money.js";

/** The month we are paying for: the one that just ended. Format YYYY-MM. */
export function periodToPay(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Rate for an account, in monthly basis points.
 * The global setting is the source of truth so changing the advertised rate in
 * admin actually changes what gets paid. A non-zero interest_bps on the
 * account overrides it, which is there for future fixed-rate products.
 */
async function rateFor(db, account, globalBps) {
  if (account.interest_bps && account.interest_bps > 0) return account.interest_bps;
  return globalBps;
}

/**
 * Balance at the start of `period`, derived from postings.
 * `period` is YYYY-MM; postings on or after the 1st of that month are backed
 * out of the current balance.
 */
async function openingBalance(db, accountId, period) {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(p.amount_cents), 0) AS since
         FROM postings p
         JOIN entries e ON e.id = p.entry_id
        WHERE p.account_id = ?
          AND e.created_at >= ?`
    )
    .bind(accountId, `${period}-01 00:00:00`)
    .first();

  const account = await ledger.getAccount(db, accountId);
  const since = row ? row.since : 0;
  return account.balance_cents - since;
}

/**
 * Pay interest for one period.
 *
 * Safe to call as often as you like. Every account is guarded independently,
 * so a run that dies halfway can simply be run again and will only pay the
 * accounts it missed.
 *
 * @returns { period, paid, skipped, totalCents, errors }
 */
export async function runInterest(env, db, { period = null, now = new Date() } = {}) {
  const target = period || periodToPay(now);
  const globalBps = parseInt(await ledger.getSetting(db, "savings_rate_bps", "200"), 10) || 0;

  const { results: accounts } = await db
    .prepare(
      `SELECT * FROM accounts
        WHERE kind = 'savings' AND status = 'active' AND balance_cents > 0
        ORDER BY id`
    )
    .all();

  let paid = 0;
  let skipped = 0;
  let totalCents = 0;
  const errors = [];

  for (const account of accounts) {
    try {
      const bps = await rateFor(db, account, globalBps);
      if (bps <= 0) {
        skipped++;
        continue;
      }

      const basis = await openingBalance(db, account.id, target);
      if (basis <= 0) {
        // Account was empty when the month began. Nothing earned.
        skipped++;
        continue;
      }

      const amount = interestCents(basis, bps);
      if (amount <= 0) {
        skipped++;
        continue;
      }
      assertCents(amount);

      // The money first. This key is what makes paying twice impossible.
      const res = await ledger.postEntry(db, {
        kind: "interest",
        memo: `Interest for ${target} at ${(bps / 100).toFixed(2)}% monthly`,
        idempotencyKey: `interest:${account.id}:${target}`,
        postings: [
          { accountId: account.id, amountCents: amount },
          { accountId: ledger.EQUITY_ACCOUNT_ID, amountCents: -amount },
        ],
      });

      if (res.duplicate) {
        // Already paid this month. Nothing to do, and nothing went wrong.
        skipped++;
        continue;
      }

      // Report row. INSERT OR IGNORE because the entry above is the real
      // guard and we never want a reporting failure to look like a payment
      // failure.
      await db
        .prepare(
          `INSERT OR IGNORE INTO interest_runs
             (account_id, period, basis_cents, rate_bps, amount_cents, entry_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(account.id, target, basis, bps, amount, res.entryId)
        .run();

      paid++;
      totalCents += amount;
    } catch (err) {
      errors.push({ accountId: account.id, error: err.message });
    }
  }

  if (paid > 0 || errors.length) {
    await ledger.audit(db, {
      action: "interest.run",
      targetType: "period",
      targetId: target,
      detail: `paid ${paid}, skipped ${skipped}, total ${totalCents} cents, ${errors.length} error(s)`,
    });
  }

  return { period: target, paid, skipped, totalCents, errors };
}

/**
 * Cron entry point. Only acts in the first few days of the month, but is
 * harmless if it runs more often, because every payment is guarded by its
 * idempotency key. The window exists so a bank that was down on the 1st still
 * pays its customers rather than skipping a month entirely.
 */
export async function maybeRunMonthly(env, db, now = new Date()) {
  if (now.getUTCDate() > 3) return { skipped: "not in payment window" };
  return await runInterest(env, db, { now });
}

/** What has been paid, for the admin dashboard. */
export async function recentRuns(db, limit = 50) {
  const { results } = await db
    .prepare(
      `SELECT r.*, a.label, u.discord_username, u.mc_username
         FROM interest_runs r
         JOIN accounts a ON a.id = r.account_id
         LEFT JOIN users u ON u.id = a.owner_user_id
        ORDER BY r.id DESC LIMIT ?`
    )
    .bind(limit)
    .all();
  return results;
}

/** Totals per period, so the owner can see what the subsidy costs monthly. */
export async function periodTotals(db) {
  const { results } = await db
    .prepare(
      `SELECT period, COUNT(*) AS accounts, SUM(amount_cents) AS total_cents
         FROM interest_runs GROUP BY period ORDER BY period DESC LIMIT 12`
    )
    .all();
  return results;
}
