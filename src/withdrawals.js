// withdrawals.js - real money leaving the bank.
// ===========================================================================
// The most dangerous code in the system. Read this before changing anything.
//
// ORDER OF OPERATIONS - deliberate, not accidental:
//
//   1. Insert the withdrawal row (no money has moved yet)
//   2. Debit the ledger        <- money is now reserved
//   3. Call the Treasury       <- money actually leaves
//
// Debiting BEFORE paying means a customer can never spend the same balance
// twice while a payout is in flight. The cost is that a crash between 2 and 3
// leaves money reserved but unpaid - visible, recoverable, and fixable by the
// reconciler. The opposite ordering risks paying twice, which is money gone
// with no way to get it back.
//
// THE THREE OUTCOMES of a Treasury call, and why they are not interchangeable:
//
//   success              -> mark sent. Done.
//   definitive failure   -> the transfer provably did not happen (4xx).
//                           Reverse the ledger entry. Customer made whole.
//   UNKNOWN (timeout/5xx)-> it may or may not have gone through.
//                           status='needs_review'. DO NOT REVERSE, DO NOT
//                           RETRY WITH A NEW KEY. Reversing here would refund
//                           a payment that actually succeeded - paying twice
//                           by a slower route.
//
// Recovery for UNKNOWN re-sends the SAME Idempotency-Key. The Treasury returns
// the original result rather than transferring again, so we learn what really
// happened without risking a second payout.
// ===========================================================================

import * as ledger from "./ledger.js";
import * as treasury from "./treasury.js";
import { assertCents } from "./money.js";

export class WithdrawalError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Request a withdrawal to a Minecraft player.
 * Returns { withdrawalId, status, txnId? }.
 */
export async function requestWithdrawal(env, db, { accountId, userId, amountCents, memo = null }) {
  assertCents(amountCents);
  if (amountCents <= 0) throw new WithdrawalError("BAD_AMOUNT", "Amount must be positive.");

  // --- gates -------------------------------------------------------------
  if ((await ledger.getSetting(db, "withdrawals_paused", "0")) === "1") {
    throw new WithdrawalError("PAUSED", "Withdrawals are temporarily paused. Your balance is unaffected.");
  }

  const account = await ledger.getAccount(db, accountId);
  ledger.assertUsable(account);
  if (account.owner_user_id !== userId) {
    throw new WithdrawalError("NOT_YOURS", "That isn't your account.");
  }

  const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first();
  if (!user || !user.mc_verified_at || !user.mc_uuid) {
    throw new WithdrawalError(
      "UNVERIFIED",
      "Verify your Minecraft account before withdrawing. This is what stops someone else's money reaching you."
    );
  }

  if (account.balance_cents < amountCents) {
    throw new WithdrawalError("INSUFFICIENT_FUNDS", "Not enough money in that account.");
  }

  // Never pay out more than the pool actually holds. If our books and the
  // Treasury disagree, stop - do not find out mid-transfer.
  let poolCents;
  try {
    poolCents = await treasury.poolBalanceCents(env);
  } catch (err) {
    throw new WithdrawalError("TREASURY_DOWN", "Can't reach the Treasury right now. Try again shortly.");
  }
  if (poolCents < amountCents) {
    await ledger.audit(db, {
      actorId: userId,
      action: "withdrawal.blocked_illiquid",
      targetType: "account",
      targetId: accountId,
      detail: `requested ${amountCents}, pool ${poolCents}`,
    });
    throw new WithdrawalError("ILLIQUID", "The bank can't cover that right now. Staff have been notified.");
  }

  // --- 1. record the intent (no money moved) ------------------------------
  const idempotencyKey = crypto.randomUUID();
  const ins = await db
    .prepare(
      `INSERT INTO withdrawals
         (account_id, requested_by, amount_cents, to_player_uuid, to_player_name,
          idempotency_key, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    )
    .bind(accountId, userId, amountCents, user.mc_uuid, user.mc_username, idempotencyKey)
    .run();
  const withdrawalId = ins.meta.last_row_id;

  // --- 2. debit the ledger ------------------------------------------------
  try {
    const res = await ledger.postEntry(db, {
      kind: "withdrawal",
      memo: memo || `Withdrawal #${withdrawalId}`,
      idempotencyKey: `withdrawal:${withdrawalId}`,
      createdBy: userId,
      postings: [
        { accountId, amountCents: -amountCents },
        { accountId: ledger.POOL_ACCOUNT_ID, amountCents: amountCents },
      ],
    });
    await db.prepare(`UPDATE withdrawals SET entry_id = ? WHERE id = ?`).bind(res.entryId, withdrawalId).run();
  } catch (err) {
    // Ledger refused (almost certainly the overdraft CHECK). No money moved.
    await db
      .prepare(`UPDATE withdrawals SET status = 'failed', failure_reason = ? WHERE id = ?`)
      .bind(String(err.message).slice(0, 300), withdrawalId)
      .run();
    throw new WithdrawalError("INSUFFICIENT_FUNDS", "Not enough money in that account.");
  }

  // --- 3. pay out ---------------------------------------------------------
  return await attemptPayout(env, db, withdrawalId);
}

/**
 * Send (or re-send) the Treasury transfer for a withdrawal.
 * Safe to call repeatedly: it always uses the withdrawal's stored
 * idempotency_key, so the Treasury will not pay twice.
 */
export async function attemptPayout(env, db, withdrawalId) {
  const w = await db.prepare(`SELECT * FROM withdrawals WHERE id = ?`).bind(withdrawalId).first();
  if (!w) throw new WithdrawalError("NOT_FOUND", "Withdrawal not found.");
  if (w.status === "sent") return { withdrawalId, status: "sent", txnId: w.treasury_txn_id };
  if (w.status === "failed") return { withdrawalId, status: "failed" };

  await db.prepare(`UPDATE withdrawals SET attempts = attempts + 1 WHERE id = ?`).bind(withdrawalId).run();

  try {
    const result = await treasury.payPlayer(env, {
      toPlayerUuid: w.to_player_uuid,
      toPlayerName: w.to_player_name,
      amountCents: w.amount_cents,
      memo: `Z&E Bank withdrawal #${withdrawalId}`,
      idempotencyKey: w.idempotency_key, // the SAME key on every attempt
    });

    await db
      .prepare(
        `UPDATE withdrawals SET status = 'sent', treasury_txn_id = ?,
         settled_at = datetime('now'), failure_reason = NULL WHERE id = ?`
      )
      .bind(result.txnId, withdrawalId)
      .run();

    return { withdrawalId, status: "sent", txnId: result.txnId };
  } catch (err) {
    const retryable = err instanceof treasury.TreasuryError ? err.retryable : true;

    if (!retryable) {
      // Provably didn't happen -> give the money back.
      await reverse(db, w, err.message);
      return { withdrawalId, status: "failed", error: err.message };
    }

    // Unknown. Park it. A human or the reconciler resolves this; nothing here
    // reverses or re-sends automatically with a new key.
    await db
      .prepare(`UPDATE withdrawals SET status = 'needs_review', failure_reason = ? WHERE id = ?`)
      .bind(String(err.message).slice(0, 300), withdrawalId)
      .run();
    await ledger.audit(db, {
      action: "withdrawal.needs_review",
      targetType: "withdrawal",
      targetId: withdrawalId,
      detail: err.message,
    });
    return { withdrawalId, status: "needs_review", error: err.message };
  }
}

/** Return a debited-but-unpaid withdrawal to the customer. */
async function reverse(db, w, reason) {
  const res = await ledger.postEntry(db, {
    kind: "withdrawal_reversal",
    memo: `Reversal of withdrawal #${w.id}`,
    idempotencyKey: `withdrawal-reversal:${w.id}`, // one reversal, ever
    postings: [
      { accountId: ledger.POOL_ACCOUNT_ID, amountCents: -w.amount_cents },
      { accountId: w.account_id, amountCents: w.amount_cents },
    ],
  });
  await db
    .prepare(
      `UPDATE withdrawals SET status = 'failed', reversal_entry_id = ?, failure_reason = ? WHERE id = ?`
    )
    .bind(res.entryId, String(reason).slice(0, 300), w.id)
    .run();
}

/**
 * Resolve stuck withdrawals. Run on a cron and available to admins.
 *
 * Re-sends the original Idempotency-Key. If the first attempt succeeded, the
 * Treasury replies with that same transfer and we mark it sent - the customer
 * was paid once. If it definitively failed, we reverse. If still unknown, we
 * leave it alone rather than guess.
 */
export async function reviewStuck(env, db, { limit = 20 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT * FROM withdrawals
       WHERE status IN ('pending','needs_review')
         AND created_at < datetime('now', '-2 minutes')
       ORDER BY id LIMIT ?`
    )
    .bind(limit)
    .all();

  const out = { resolved: 0, stillUnknown: 0, reversed: 0 };
  for (const w of results) {
    const r = await attemptPayout(env, db, w.id);
    if (r.status === "sent") out.resolved++;
    else if (r.status === "failed") out.reversed++;
    else out.stillUnknown++;
  }
  return out;
}

export async function listForAccount(db, accountId, limit = 25) {
  const { results } = await db
    .prepare(`SELECT * FROM withdrawals WHERE account_id = ? ORDER BY id DESC LIMIT ?`)
    .bind(accountId, limit)
    .all();
  return results;
}

export async function listNeedingReview(db) {
  const { results } = await db
    .prepare(
      `SELECT w.*, a.label, u.discord_username, u.mc_username
       FROM withdrawals w
       JOIN accounts a ON a.id = w.account_id
       LEFT JOIN users u ON u.id = w.requested_by
       WHERE w.status IN ('pending','needs_review') ORDER BY w.id DESC`
    )
    .all();
  return results;
}
