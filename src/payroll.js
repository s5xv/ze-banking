// payroll.js - paying a company's employees.
// ===========================================================================
// Wages are internal transfers between Z&E accounts, so payroll never calls
// the Treasury. That is deliberate: the Treasury allows 120 transfers a minute
// for the whole bank, and a company with fifty staff running payroll at the
// same time as everyone else would half complete. Internally there is no such
// limit and no partial failure.
//
// DOUBLE PAYMENT is guarded twice over:
//   * UNIQUE(business_id, user_id, period) on payroll_runs
//   * a deterministic entry key, payroll:<business>:<user>:<period>
// Being paid your salary twice is the single worst bug this feature could
// have, so it is prevented by the database rather than by careful code.
//
// UNDERFUNDED PAYROLL is refused as a whole rather than paid partially. Paying
// four people out of five and leaving the fifth wondering is worse than paying
// nobody and saying why.
// ===========================================================================

import * as ledger from "./ledger.js";
import * as biz from "./business.js";
import { assertCents, sumCents } from "./money.js";

export function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// managing salaries
// ---------------------------------------------------------------------------
export async function setSalary(db, business, actor, { userId, amountCents }) {
  assertCents(amountCents);
  if (amountCents <= 0) throw new Error("A salary must be more than zero.");

  const member = await biz.roleFor(db, business.id, userId);
  if (!member) throw new Error("That person is not a member of this company.");

  await db
    .prepare(
      `INSERT INTO payroll (business_id, user_id, amount_cents, created_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(business_id, user_id)
       DO UPDATE SET amount_cents = excluded.amount_cents, active = 1`
    )
    .bind(business.id, userId, amountCents, actor.id)
    .run();

  await ledger.audit(db, {
    actorId: actor.id,
    action: "payroll.salary_set",
    targetType: "business",
    targetId: business.id,
    detail: `user ${userId} at ${amountCents} cents`,
  });
}

export async function removeSalary(db, business, actor, userId) {
  await db
    .prepare(`UPDATE payroll SET active = 0 WHERE business_id = ? AND user_id = ?`)
    .bind(business.id, userId)
    .run();
  await ledger.audit(db, {
    actorId: actor.id,
    action: "payroll.salary_removed",
    targetType: "business",
    targetId: business.id,
    detail: String(userId),
  });
}

export async function listSalaries(db, businessId) {
  const { results } = await db
    .prepare(
      `SELECT p.*, u.discord_username, u.mc_username, m.role
         FROM payroll p
         JOIN users u ON u.id = p.user_id
    LEFT JOIN business_members m ON m.business_id = p.business_id AND m.user_id = p.user_id
        WHERE p.business_id = ? AND p.active = 1
        ORDER BY u.mc_username`
    )
    .bind(businessId)
    .all();
  return results;
}

export async function payrollTotal(db, businessId) {
  const r = await db
    .prepare(`SELECT COALESCE(SUM(amount_cents),0) AS total FROM payroll WHERE business_id = ? AND active = 1`)
    .bind(businessId)
    .first();
  return r ? r.total : 0;
}

// ---------------------------------------------------------------------------
// running payroll
// ---------------------------------------------------------------------------
/**
 * Pay everyone for one period.
 *
 * @returns { period, paid, skipped, totalCents, shortfall }
 *   shortfall is set when the company cannot cover the full run, in which case
 *   NOBODY is paid.
 */
export async function runPayroll(db, business, { period = null, now = new Date(), actor = null } = {}) {
  const target = period || currentPeriod(now);

  const account = await biz.businessAccount(db, business.id);
  if (!account) return { period: target, paid: 0, skipped: 0, error: "This company has no account." };

  const salaries = await listSalaries(db, business.id);
  if (!salaries.length) return { period: target, paid: 0, skipped: 0, error: "No salaries set." };

  // Who has already been paid this period? They are excluded from both the
  // affordability check and the run, so a re-run after adding one person does
  // not require funding everybody again.
  const { results: already } = await db
    .prepare(`SELECT user_id FROM payroll_runs WHERE business_id = ? AND period = ? AND status = 'paid'`)
    .bind(business.id, target)
    .all();
  const paidIds = new Set(already.map((r) => r.user_id));

  const due = salaries.filter((s) => !paidIds.has(s.user_id));
  if (!due.length) return { period: target, paid: 0, skipped: salaries.length, alreadyDone: true };

  const needed = sumCents(due.map((s) => s.amount_cents));

  // All or nothing. A half finished payroll is worse than a clear refusal.
  if (account.balance_cents < needed) {
    return {
      period: target,
      paid: 0,
      skipped: due.length,
      shortfall: needed - account.balance_cents,
      needed,
      available: account.balance_cents,
    };
  }

  let paid = 0;
  let totalCents = 0;
  const failures = [];

  for (const s of due) {
    const target_account = await ledger.defaultAccountForUser(db, s.user_id);
    if (!target_account) {
      failures.push({ userId: s.user_id, reason: "no account to pay into" });
      continue;
    }

    try {
      const res = await ledger.postEntry(db, {
        kind: "transfer",
        memo: `${business.display_name} wages, ${target}`,
        idempotencyKey: `payroll:${business.id}:${s.user_id}:${target}`,
        createdBy: actor ? actor.id : null,
        postings: [
          { accountId: account.id, amountCents: -s.amount_cents },
          { accountId: target_account.id, amountCents: s.amount_cents },
        ],
      });

      await db
        .prepare(
          `INSERT OR IGNORE INTO payroll_runs
             (business_id, user_id, period, amount_cents, entry_id, status)
           VALUES (?, ?, ?, ?, ?, 'paid')`
        )
        .bind(business.id, s.user_id, target, s.amount_cents, res.entryId)
        .run();

      if (!res.duplicate) {
        paid++;
        totalCents += s.amount_cents;
      }
    } catch (err) {
      failures.push({ userId: s.user_id, reason: err.message });
      await db
        .prepare(
          `INSERT OR IGNORE INTO payroll_runs
             (business_id, user_id, period, amount_cents, status)
           VALUES (?, ?, ?, ?, 'failed')`
        )
        .bind(business.id, s.user_id, target, s.amount_cents)
        .run();
    }
  }

  await ledger.audit(db, {
    actorId: actor ? actor.id : null,
    action: "payroll.run",
    targetType: "business",
    targetId: business.id,
    detail: `${target}: paid ${paid}, total ${totalCents} cents, ${failures.length} failed`,
  });

  return { period: target, paid, skipped: failures.length, totalCents, failures };
}

/** Cron entry point. Runs payroll for every active company once a month. */
export async function runAllPayroll(db, { now = new Date() } = {}) {
  if (now.getUTCDate() > 3) return { skipped: "not in payroll window" };

  const { results } = await db
    .prepare(`SELECT * FROM businesses WHERE status = 'active' ORDER BY id`)
    .all();

  let companies = 0;
  let people = 0;
  let short = 0;

  for (const b of results) {
    const r = await runPayroll(db, b, { now });
    if (r.paid) {
      companies++;
      people += r.paid;
    }
    if (r.shortfall) short++;
  }
  return { companies, people, short };
}

export async function runHistory(db, businessId, limit = 30) {
  const { results } = await db
    .prepare(
      `SELECT r.*, u.mc_username, u.discord_username
         FROM payroll_runs r JOIN users u ON u.id = r.user_id
        WHERE r.business_id = ? ORDER BY r.id DESC LIMIT ?`
    )
    .bind(businessId, limit)
    .all();
  return results;
}
