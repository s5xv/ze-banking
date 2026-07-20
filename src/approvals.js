// approvals.js - money that needs a signature before it moves.
// ===========================================================================
// Covers two requirements with one mechanism, because they are the same thing:
//
//   1. Savings withdrawals need staff to accept them.
//   2. Joint accounts need N signatures above a threshold the owners set.
//
// THE CENTRAL DECISION: money does NOT leave the account when a request is
// made. It leaves when the request executes, and the balance is checked again
// at that moment.
//
// The alternative, debiting on request and refunding on rejection, looks
// tidier and is a trap. Refunds are where double spends live: a refund that
// fires twice, or fires after the request already executed, invents money.
// Not moving anything until the moment of execution means a rejected request
// is simply deleted, and nothing has to be undone.
//
// The cost is that a pending request does not reserve funds, so an approval
// can fail at execution because the money was spent in the meantime. That is
// correct behaviour, and it says so plainly.
// ===========================================================================

import * as ledger from "./ledger.js";

export class ApprovalError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Does this movement need signing off, and by how many people?
 * Returns { needed: number, reason: string } or null if it can proceed now.
 */
export async function approvalRequired(db, account, amountCents) {
  // Staff approval on savings, as specified.
  if (account.requires_approval) {
    return { needed: 1, staff: true, reason: "Withdrawals from savings are checked by staff." };
  }

  // Joint account threshold.
  if (account.joint_threshold_cents && amountCents >= account.joint_threshold_cents) {
    const n = Math.max(1, account.signatures_required || 1);
    return {
      needed: n,
      staff: false,
      reason: `Amounts of ${account.joint_threshold_cents / 100} or more need ${n} signatures.`,
    };
  }

  return null;
}

/**
 * Record a request. Nothing moves yet.
 * The requester's own signature counts immediately if they are a signer.
 */
export async function requestApproval(db, {
  fromAccount,
  toAccountId = null,
  kind,
  amountCents,
  memo,
  user,
  needed,
}) {
  const r = await db
    .prepare(
      `INSERT INTO pending_transfers
         (from_account_id, to_account_id, kind, amount_cents, memo, requested_by,
          signatures_needed, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 days'))`
    )
    .bind(fromAccount.id, toAccountId, kind, amountCents, memo || null, user.id, needed)
    .run();

  const pendingId = r.meta.last_row_id;

  // A joint signer who requests a payment has, by requesting it, signed it.
  // Staff approvals do not work this way: the customer requesting does not
  // count towards staff sign off.
  if (!fromAccount.requires_approval) {
    const isSigner = await db
      .prepare(`SELECT 1 AS ok FROM account_signers WHERE account_id = ? AND user_id = ?`)
      .bind(fromAccount.id, user.id)
      .first();
    if (isSigner) {
      await db
        .prepare(`INSERT OR IGNORE INTO pending_signatures (pending_id, user_id) VALUES (?, ?)`)
        .bind(pendingId, user.id)
        .run();
    }
  }

  await ledger.audit(db, {
    actorId: user.id,
    action: "approval.requested",
    targetType: "pending",
    targetId: pendingId,
    detail: `${kind} ${amountCents} cents from account ${fromAccount.id}`,
  });

  return pendingId;
}

export async function getPending(db, id) {
  return await db.prepare(`SELECT * FROM pending_transfers WHERE id = ?`).bind(id).first();
}

export async function signatureCount(db, pendingId) {
  const r = await db
    .prepare(`SELECT COUNT(*) AS n FROM pending_signatures WHERE pending_id = ?`)
    .bind(pendingId)
    .first();
  return r ? r.n : 0;
}

export async function signatures(db, pendingId) {
  const { results } = await db
    .prepare(
      `SELECT s.*, u.discord_username, u.mc_username
         FROM pending_signatures s JOIN users u ON u.id = s.user_id
        WHERE s.pending_id = ? ORDER BY s.id`
    )
    .bind(pendingId)
    .all();
  return results;
}

/** May this user sign this request? */
export async function canSign(db, pending, user) {
  const account = await ledger.getAccount(db, pending.from_account_id);
  if (!account) return false;

  if (account.requires_approval) {
    // Staff only, and never the person who asked for it.
    return (user.role === "staff" || user.role === "admin") && user.id !== pending.requested_by;
  }

  const signer = await db
    .prepare(`SELECT 1 AS ok FROM account_signers WHERE account_id = ? AND user_id = ?`)
    .bind(account.id, user.id)
    .first();
  return !!signer;
}

/**
 * Add a signature. When the threshold is met the transfer executes
 * immediately, inside this call, so there is no window where a request is
 * fully signed but unpaid.
 *
 * @returns { signed, executed, entryId } or throws
 */
export async function sign(db, pendingId, user) {
  const pending = await getPending(db, pendingId);
  if (!pending) throw new ApprovalError("NOT_FOUND", "That request no longer exists.");
  if (pending.status !== "pending") {
    throw new ApprovalError("DECIDED", `That request is already ${pending.status}.`);
  }
  if (pending.expires_at && new Date(String(pending.expires_at).replace(" ", "T") + "Z") < new Date()) {
    await db.prepare(`UPDATE pending_transfers SET status = 'expired' WHERE id = ?`).bind(pendingId).run();
    throw new ApprovalError("EXPIRED", "That request expired.");
  }
  if (!(await canSign(db, pending, user))) {
    throw new ApprovalError("NOT_ALLOWED", "You cannot approve this request.");
  }

  // UNIQUE(pending_id, user_id) means one person cannot sign twice to reach a
  // threshold of two on their own.
  try {
    await db
      .prepare(`INSERT INTO pending_signatures (pending_id, user_id) VALUES (?, ?)`)
      .bind(pendingId, user.id)
      .run();
  } catch {
    throw new ApprovalError("ALREADY_SIGNED", "You have already approved this.");
  }

  const count = await signatureCount(db, pendingId);
  if (count < pending.signatures_needed) {
    return { signed: true, executed: false, have: count, need: pending.signatures_needed };
  }

  return await execute(db, pendingId, user);
}

/**
 * Move the money. Called only once the signature threshold is met.
 *
 * The balance is re-checked here by the ledger itself: postEntry runs against
 * the overdraft CHECK, so if the money was spent while the request sat
 * pending, this fails cleanly and the request is marked rejected rather than
 * quietly overdrawing the account.
 */
async function execute(db, pendingId, actor) {
  const pending = await getPending(db, pendingId);
  if (!pending || pending.status !== "pending") {
    throw new ApprovalError("DECIDED", "That request has already been handled.");
  }

  // Internal transfers only. A savings withdrawal to a Minecraft account is
  // handled by the caller in withdrawals.js, which owns the Treasury path.
  if (pending.kind !== "transfer" || !pending.to_account_id) {
    await db
      .prepare(
        `UPDATE pending_transfers SET status = 'approved', decided_by = ?, decided_at = datetime('now')
          WHERE id = ?`
      )
      .bind(actor.id, pendingId)
      .run();
    return { signed: true, executed: false, approved: true };
  }

  try {
    const res = await ledger.postEntry(db, {
      kind: "transfer",
      memo: pending.memo || "Approved transfer",
      idempotencyKey: `pending:${pendingId}`, // one execution, ever
      createdBy: pending.requested_by,
      postings: [
        { accountId: pending.from_account_id, amountCents: -pending.amount_cents },
        { accountId: pending.to_account_id, amountCents: pending.amount_cents },
      ],
    });

    await db
      .prepare(
        `UPDATE pending_transfers
            SET status = 'executed', decided_by = ?, decided_at = datetime('now'), entry_id = ?
          WHERE id = ?`
      )
      .bind(actor.id, res.entryId, pendingId)
      .run();

    await ledger.audit(db, {
      actorId: actor.id,
      action: "approval.executed",
      targetType: "pending",
      targetId: pendingId,
    });

    return { signed: true, executed: true, entryId: res.entryId };
  } catch (err) {
    await db
      .prepare(
        `UPDATE pending_transfers
            SET status = 'rejected', reject_reason = ?, decided_at = datetime('now')
          WHERE id = ?`
      )
      .bind(`Could not complete: ${String(err.message).slice(0, 150)}`, pendingId)
      .run();
    throw new ApprovalError(
      "FAILED",
      "The account no longer has enough money for this. The request has been cancelled."
    );
  }
}

export async function reject(db, pendingId, user, reason = null) {
  const pending = await getPending(db, pendingId);
  if (!pending) throw new ApprovalError("NOT_FOUND", "That request no longer exists.");
  if (pending.status !== "pending") throw new ApprovalError("DECIDED", "Already handled.");

  const allowed = (await canSign(db, pending, user)) || pending.requested_by === user.id;
  if (!allowed) throw new ApprovalError("NOT_ALLOWED", "You cannot reject this request.");

  await db
    .prepare(
      `UPDATE pending_transfers
          SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), reject_reason = ?
        WHERE id = ?`
    )
    .bind(user.id, String(reason || "").slice(0, 200) || null, pendingId)
    .run();

  await ledger.audit(db, {
    actorId: user.id,
    action: "approval.rejected",
    targetType: "pending",
    targetId: pendingId,
    detail: reason || "",
  });
}

// ---------------------------------------------------------------------------
// listings
// ---------------------------------------------------------------------------
/** Everything waiting on staff. */
export async function listForStaff(db) {
  const { results } = await db
    .prepare(
      `SELECT p.*, a.label AS from_label, a.kind AS from_kind,
              u.discord_username, u.mc_username,
              (SELECT COUNT(*) FROM pending_signatures s WHERE s.pending_id = p.id) AS have
         FROM pending_transfers p
         JOIN accounts a ON a.id = p.from_account_id
         JOIN users u ON u.id = p.requested_by
        WHERE p.status = 'pending' AND a.requires_approval = 1
        ORDER BY p.id`
    )
    .all();
  return results;
}

/** Everything this user can see or act on. */
export async function listForUser(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT p.*, a.label AS from_label,
              (SELECT COUNT(*) FROM pending_signatures s WHERE s.pending_id = p.id) AS have,
              (SELECT COUNT(*) FROM pending_signatures s WHERE s.pending_id = p.id AND s.user_id = ?) AS mine
         FROM pending_transfers p
         JOIN accounts a ON a.id = p.from_account_id
        WHERE p.status = 'pending'
          AND (a.owner_user_id = ?
               OR EXISTS (SELECT 1 FROM account_signers g
                           WHERE g.account_id = a.id AND g.user_id = ?))
        ORDER BY p.id`
    )
    .bind(userId, userId, userId)
    .all();
  return results;
}

/** Sweep requests nobody acted on. */
export async function expireOld(db) {
  const r = await db
    .prepare(
      `UPDATE pending_transfers SET status = 'expired'
        WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')`
    )
    .run();
  return r.meta.changes;
}

// ---------------------------------------------------------------------------
// joint account signers
// ---------------------------------------------------------------------------
export async function listSigners(db, accountId) {
  const { results } = await db
    .prepare(
      `SELECT g.*, u.discord_username, u.mc_username
         FROM account_signers g JOIN users u ON u.id = g.user_id
        WHERE g.account_id = ? ORDER BY g.id`
    )
    .bind(accountId)
    .all();
  return results;
}

export async function addSigner(db, account, actor, mcUsername) {
  if (account.owner_user_id !== actor.id) throw new ApprovalError("NOT_YOURS", "Not your account.");

  const target = await db
    .prepare(
      `SELECT * FROM users WHERE LOWER(mc_username) = LOWER(?)
         AND mc_verified_at IS NOT NULL AND status = 'active'`
    )
    .bind(String(mcUsername || "").trim())
    .first();
  if (!target) throw new ApprovalError("NO_USER", "No verified customer with that Minecraft name.");

  // Three signers is the ceiling, matching the Platinum "multi signer up to 3"
  // perk. More than that and the approval maths gets confusing for owners.
  const existing = await listSigners(db, account.id);
  if (existing.length >= 3) throw new ApprovalError("TOO_MANY", "An account can have at most 3 signers.");

  await db
    .prepare(`INSERT OR IGNORE INTO account_signers (account_id, user_id, added_by) VALUES (?, ?, ?)`)
    .bind(account.id, target.id, actor.id)
    .run();

  await ledger.audit(db, {
    actorId: actor.id,
    action: "account.signer_added",
    targetType: "account",
    targetId: account.id,
    detail: target.mc_username,
  });
}

export async function removeSigner(db, account, actor, userId) {
  if (account.owner_user_id !== actor.id) throw new ApprovalError("NOT_YOURS", "Not your account.");
  await db
    .prepare(`DELETE FROM account_signers WHERE account_id = ? AND user_id = ?`)
    .bind(account.id, userId)
    .run();
}

/** Set the threshold and how many signatures are needed above it. */
export async function setJointRules(db, account, actor, { thresholdCents, signaturesRequired }) {
  if (account.owner_user_id !== actor.id) throw new ApprovalError("NOT_YOURS", "Not your account.");

  const signers = await listSigners(db, account.id);
  const n = Math.max(1, Math.min(3, parseInt(signaturesRequired, 10) || 1));

  // Requiring more signatures than there are signers would lock the account
  // permanently, with no way to approve anything.
  if (thresholdCents && n > signers.length + 1) {
    throw new ApprovalError(
      "IMPOSSIBLE",
      `You have ${signers.length} other signer(s). Requiring ${n} signatures would lock the account.`
    );
  }

  await db
    .prepare(`UPDATE accounts SET joint_threshold_cents = ?, signatures_required = ? WHERE id = ?`)
    .bind(thresholdCents && thresholdCents > 0 ? thresholdCents : null, n, account.id)
    .run();

  await ledger.audit(db, {
    actorId: actor.id,
    action: "account.joint_rules_set",
    targetType: "account",
    targetId: account.id,
    detail: `threshold ${thresholdCents}, ${n} signatures`,
  });
}
