// products.js - fixed deposits, savings goals, scheduled payments.
// ===========================================================================
// All three are built on the same guarantees as the rest of the bank:
//   * money only ever moves through ledger.postEntry
//   * every automated payment has a deterministic idempotency key, so the
//     runner can fire as often as it likes without paying twice
//   * nothing here can create money; it comes from an account or not at all
// ===========================================================================

import * as ledger from "./ledger.js";
import * as biz from "./business.js";
import { assertCents } from "./money.js";

// ---------------------------------------------------------------------------
// FIXED DEPOSITS
// ---------------------------------------------------------------------------
export const CD_TERMS = [1, 3, 6, 12];

/**
 * Rate for a new CD, in monthly basis points.
 *
 * Base rate comes from settings. If the money is coming from a company
 * account, the company's tier bonus is added, which is what makes the Gold and
 * Platinum "rate bonus" perk a real thing rather than marketing.
 *
 * The rate is fixed at open and stored on the account, so a later change to
 * the global rate does not retroactively alter an existing deposit. That is
 * the whole point of a fixed deposit.
 */
export async function cdRateFor(db, sourceAccount) {
  const base = parseInt(await ledger.getSetting(db, "cd_rate_bps", "300"), 10) || 0;
  if (!sourceAccount || !sourceAccount.owner_business_id) return base;

  const business = await biz.getBusiness(db, sourceAccount.owner_business_id);
  const tier = biz.effectiveTier(business);
  return base + (tier.cdBonusBps || 0);
}

/**
 * Open a fixed deposit by moving money out of an existing account.
 *
 * The transfer and the lock are separate steps, in this order: create the
 * locked account first, then move the money into it. If the transfer fails,
 * an empty locked account is left behind, which is harmless. Doing it the
 * other way could move money into an account that does not exist yet.
 */
export async function openCd(db, { user, fromAccountId, amountCents, termMonths }) {
  assertCents(amountCents);
  if (amountCents <= 0) throw new Error("Amount must be positive.");
  if (!CD_TERMS.includes(Number(termMonths))) throw new Error("Choose a valid term.");

  const source = await ledger.getAccount(db, fromAccountId);
  ledger.assertWithdrawable(source);
  if (source.owner_user_id !== user.id) throw new Error("That is not your account.");
  if (source.cd_matures_at) throw new Error("You cannot fund a fixed deposit from another one.");
  if (source.balance_cents < amountCents) throw new Error("Not enough money in that account.");

  const rate = await cdRateFor(db, source);
  const months = Number(termMonths);

  const ins = await db
    .prepare(
      `INSERT INTO accounts
         (owner_user_id, owner_business_id, kind, label, interest_bps, allow_negative,
          deposit_code, cd_matures_at, cd_term_months, cd_opened_cents)
       VALUES (?, ?, 'savings', ?, ?, 0, NULL,
               datetime('now', '+' || ? || ' months'), ?, ?)`
    )
    .bind(
      user.id,
      source.owner_business_id || null,
      `${months} month fixed deposit`,
      rate,
      months,
      months,
      amountCents
    )
    .run();

  const cdId = ins.meta.last_row_id;

  await ledger.postEntry(db, {
    kind: "transfer",
    memo: `Opened ${months} month fixed deposit at ${(rate / 100).toFixed(2)}% monthly`,
    idempotencyKey: `cd-open:${cdId}`,
    createdBy: user.id,
    postings: [
      { accountId: source.id, amountCents: -amountCents },
      { accountId: cdId, amountCents: amountCents },
    ],
  });

  await ledger.audit(db, {
    actorId: user.id,
    action: "cd.opened",
    targetType: "account",
    targetId: cdId,
    detail: `${amountCents} cents for ${months} months at ${rate} bps`,
  });

  return { cdId, rate, months };
}

export async function listCds(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT * FROM accounts
        WHERE owner_user_id = ? AND cd_matures_at IS NOT NULL AND status <> 'closed'
        ORDER BY cd_matures_at`
    )
    .bind(userId)
    .all();
  return results;
}

export const cdMatured = (a) =>
  !!a.cd_matures_at && new Date(String(a.cd_matures_at).replace(" ", "T") + "Z") <= new Date();

// ---------------------------------------------------------------------------
// SAVINGS GOALS
// ---------------------------------------------------------------------------
// Pure presentation. No money mechanics at all, which is why there is nothing
// here to guard.
export async function setGoal(db, user, accountId, { goalCents, label }) {
  const account = await ledger.getAccount(db, accountId);
  if (!account || account.owner_user_id !== user.id) throw new Error("That is not your account.");
  if (account.kind !== "savings") throw new Error("Goals are for savings accounts.");

  await db
    .prepare(`UPDATE accounts SET goal_cents = ?, goal_label = ? WHERE id = ?`)
    .bind(goalCents && goalCents > 0 ? goalCents : null, label ? String(label).slice(0, 60) : null, accountId)
    .run();
}

export function goalProgress(account) {
  if (!account.goal_cents || account.goal_cents <= 0) return null;
  const pct = Math.min(100, Math.round((account.balance_cents / account.goal_cents) * 100));
  return { pct, reached: account.balance_cents >= account.goal_cents };
}

// ---------------------------------------------------------------------------
// SCHEDULED PAYMENTS
// ---------------------------------------------------------------------------
export async function createSchedule(db, user, { fromAccountId, toAccountId, amountCents, memo, frequency, firstRun }) {
  assertCents(amountCents);
  if (amountCents <= 0) throw new Error("Amount must be positive.");
  if (!["weekly", "monthly"].includes(frequency)) throw new Error("Choose weekly or monthly.");

  const from = await ledger.getAccount(db, fromAccountId);
  ledger.assertWithdrawable(from);
  if (from.owner_user_id !== user.id) throw new Error("That is not your account.");

  const to = await ledger.getAccount(db, toAccountId);
  ledger.assertUsable(to);
  if (to.id === from.id) throw new Error("Pick a different destination.");

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(firstRun || ""))
    ? firstRun
    : new Date().toISOString().slice(0, 10);

  const r = await db
    .prepare(
      `INSERT INTO scheduled_payments
         (from_account_id, to_account_id, created_by, amount_cents, memo, frequency, next_run)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(from.id, to.id, user.id, amountCents, memo ? String(memo).slice(0, 80) : null, frequency, date)
    .run();

  await ledger.audit(db, {
    actorId: user.id,
    action: "schedule.created",
    targetType: "schedule",
    targetId: r.meta.last_row_id,
  });

  return r.meta.last_row_id;
}

export async function listSchedules(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT s.*, a.label AS from_label, t.label AS to_label,
              tu.mc_username AS to_person, tb.display_name AS to_company
         FROM scheduled_payments s
         JOIN accounts a  ON a.id = s.from_account_id
         JOIN accounts t  ON t.id = s.to_account_id
    LEFT JOIN users tu    ON tu.id = t.owner_user_id
    LEFT JOIN businesses tb ON tb.id = t.owner_business_id
        WHERE a.owner_user_id = ? AND s.status <> 'cancelled'
        ORDER BY s.next_run`
    )
    .bind(userId)
    .all();
  return results;
}

export async function setScheduleStatus(db, user, id, status) {
  if (!["active", "paused", "cancelled"].includes(status)) throw new Error("Bad status.");
  const s = await db
    .prepare(
      `SELECT s.* FROM scheduled_payments s JOIN accounts a ON a.id = s.from_account_id
        WHERE s.id = ? AND a.owner_user_id = ?`
    )
    .bind(id, user.id)
    .first();
  if (!s) throw new Error("Not found.");

  await db.prepare(`UPDATE scheduled_payments SET status = ? WHERE id = ?`).bind(status, id).run();
}

/**
 * Run everything due.
 *
 * Each execution is keyed sched:<id>:<date>. If the runner fires twice on the
 * same day, the second attempt is a duplicate entry and nothing moves. A
 * payment that cannot be afforded is counted and retried on the next cycle
 * rather than cancelled outright, because a temporarily empty account is not
 * the same as an instruction the customer wanted stopped. After several
 * failures it pauses itself and tells them.
 */
export async function runDueSchedules(db, { now = new Date(), limit = 100 } = {}) {
  const today = now.toISOString().slice(0, 10);

  const { results } = await db
    .prepare(
      `SELECT * FROM scheduled_payments
        WHERE status = 'active' AND next_run <= ? ORDER BY id LIMIT ?`
    )
    .bind(today, limit)
    .all();

  let paid = 0;
  let failed = 0;

  for (const s of results) {
    const due = s.next_run;
    try {
      await ledger.transferInternal(db, {
        fromAccountId: s.from_account_id,
        toAccountId: s.to_account_id,
        amountCents: s.amount_cents,
        memo: s.memo || "Scheduled payment",
        byUserId: s.created_by,
        reference: `sched:${s.id}:${due}`,
      });

      const step = s.frequency === "weekly" ? "+7 days" : "+1 month";
      await db
        .prepare(
          `UPDATE scheduled_payments
              SET last_run = ?, last_status = 'paid', fail_count = 0,
                  next_run = date(?, '${step}')
            WHERE id = ?`
        )
        .bind(due, due, s.id)
        .run();
      paid++;
    } catch (err) {
      const fails = (s.fail_count || 0) + 1;
      const pause = fails >= 3;
      await db
        .prepare(
          `UPDATE scheduled_payments
              SET fail_count = ?, last_status = ?, status = ?
            WHERE id = ?`
        )
        .bind(fails, String(err.message).slice(0, 120), pause ? "paused" : "active", s.id)
        .run();

      if (pause) {
        await ledger.audit(db, {
          action: "schedule.paused",
          targetType: "schedule",
          targetId: s.id,
          detail: `paused after ${fails} failures: ${err.message}`,
        });
      }
      failed++;
    }
  }

  return { paid, failed };
}
