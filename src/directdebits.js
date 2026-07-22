// directdebits.js - letting a business collect an agreed amount.
// ===========================================================================
// A direct debit is the opposite of a scheduled payment. With a scheduled
// payment the PAYER decides when money moves. With a direct debit the
// RECIPIENT pulls it. That is a meaningful amount of trust, so it is fenced
// in four ways:
//
//   1. Only the payer can create the mandate. A business cannot grant itself
//      permission to take someone's money.
//   2. The payer sets a per pull ceiling, and a pull above it is refused.
//   3. The payer can revoke at any time, instantly, without asking anyone.
//   4. Every pull needs a unique reference, so a business that retries a
//      failed collection cannot accidentally take the money twice.
//
// Tier limits come from the business's EFFECTIVE tier, so a company that stops
// paying cannot keep collecting on more mandates than Silver allows.
// ===========================================================================

import * as ledger from "./ledger.js";
import * as biz from "./business.js";
import * as approvals from "./approvals.js";
import * as bizhooks from "./bizhooks.js";
import { assertCents } from "./money.js";

export class DebitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// mandates
// ---------------------------------------------------------------------------
/**
 * The payer authorises a business to collect from one of their accounts.
 *
 * Deliberately created by the PAYER, not requested by the business. A request
 * and approve flow would be friendlier but doubles the surface area, and the
 * thing being granted is permission to remove money.
 */
export async function createMandate(db, user, { fromAccountId, firmName, maxCents, reference }) {
  assertCents(maxCents);
  if (maxCents <= 0) throw new DebitError("BAD_AMOUNT", "Set a limit above zero.");

  const account = await ledger.getAccount(db, fromAccountId);
  ledger.assertWithdrawable(account);
  if (account.owner_user_id !== user.id) throw new DebitError("NOT_YOURS", "That is not your account.");
  if (account.owner_business_id) {
    throw new DebitError("NOT_PERSONAL", "Set up direct debits from a personal account.");
  }

  const business = await biz.getBusinessByFirm(db, firmName);
  if (!business) throw new DebitError("NO_FIRM", `No company called "${firmName}" banks with us.`);
  if (business.status === "closed" || business.status === "suspended") {
    throw new DebitError("UNAVAILABLE", "That company cannot collect payments at the moment.");
  }

  const toAccount = await biz.businessAccount(db, business.id);
  if (!toAccount) throw new DebitError("NO_ACCOUNT", "That company has no account to collect into.");

  // Tier ceiling, counted against the collecting business.
  const tier = biz.effectiveTier(business);
  if (tier.maxDirectDebits !== Infinity) {
    const countRow = await db
      .prepare(`SELECT COUNT(*) AS n FROM direct_debits WHERE business_id = ? AND status = 'active'`)
      .bind(business.id)
      .first();
    if (countRow && countRow.n >= tier.maxDirectDebits) {
      throw new DebitError(
        "TIER_LIMIT",
        `${business.display_name} is on ${tier.name}, which allows ${tier.maxDirectDebits} direct debits, and has reached that limit.`
      );
    }
  }

  const existing = await db
    .prepare(
      `SELECT id FROM direct_debits
        WHERE from_account_id = ? AND business_id = ? AND status = 'active'`
    )
    .bind(account.id, business.id)
    .first();
  if (existing) throw new DebitError("DUPLICATE", "You already have a direct debit set up with them.");

  const r = await db
    .prepare(
      `INSERT INTO direct_debits
         (from_account_id, to_account_id, business_id, reference, max_cents, authorised_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(account.id, toAccount.id, business.id, reference ? String(reference).slice(0, 80) : null, maxCents, user.id)
    .run();

  await ledger.audit(db, {
    actorId: user.id,
    action: "directdebit.created",
    targetType: "direct_debit",
    targetId: r.meta.last_row_id,
    detail: `${business.firm_name} up to ${maxCents} cents`,
  });

  return r.meta.last_row_id;
}

/** The payer cancels. Immediate, no approval, no notice period. */
export async function revoke(db, user, id) {
  const dd = await db.prepare(`SELECT * FROM direct_debits WHERE id = ?`).bind(id).first();
  if (!dd) throw new DebitError("NOT_FOUND", "Not found.");

  const account = await ledger.getAccount(db, dd.from_account_id);
  if (!account || account.owner_user_id !== user.id) {
    throw new DebitError("NOT_YOURS", "Only the payer can cancel a direct debit.");
  }

  await db.prepare(`UPDATE direct_debits SET status = 'revoked' WHERE id = ?`).bind(id).run();
  await ledger.audit(db, {
    actorId: user.id,
    action: "directdebit.revoked",
    targetType: "direct_debit",
    targetId: id,
  });
}

/** Staff can also revoke, for disputes. */
export async function revokeByStaff(db, staff, id, reason) {
  await db.prepare(`UPDATE direct_debits SET status = 'revoked' WHERE id = ?`).bind(id).run();
  await ledger.audit(db, {
    actorId: staff.id,
    action: "directdebit.revoked_by_staff",
    targetType: "direct_debit",
    targetId: id,
    detail: reason || "",
  });
}

// ---------------------------------------------------------------------------
// collecting
// ---------------------------------------------------------------------------
/**
 * Pull money against a mandate.
 *
 * `reference` is REQUIRED and unique. A business collecting monthly should use
 * something deterministic like "invoice-2026-07", so that retrying a
 * collection that timed out cannot take the money a second time.
 */
export async function pull(db, actor, { mandateId, amountCents, reference, memo }) {
  assertCents(amountCents);
  if (amountCents <= 0) throw new DebitError("BAD_AMOUNT", "Amount must be positive.");
  if (!reference) throw new DebitError("NO_REFERENCE", "A unique reference is required for every collection.");

  const dd = await db.prepare(`SELECT * FROM direct_debits WHERE id = ?`).bind(mandateId).first();
  if (!dd) throw new DebitError("NOT_FOUND", "Mandate not found.");
  if (dd.status !== "active") throw new DebitError("REVOKED", "That direct debit has been cancelled.");

  // Only someone who can move the collecting company's money may collect.
  const role = await biz.roleFor(db, dd.business_id, actor.id);
  if (!biz.canManageMoney(role)) throw new DebitError("NOT_ALLOWED", "You cannot collect for this company.");

  if (amountCents > dd.max_cents) {
    throw new DebitError(
      "OVER_LIMIT",
      `The payer authorised up to ${dd.max_cents / 100} per collection. Ask them to raise it.`
    );
  }

  const from = await ledger.getAccount(db, dd.from_account_id);
  ledger.assertWithdrawable(from);

  // A collection large enough to need signatures is refused rather than
  // queued. Silently parking a business's collection in someone else's
  // approval list would leave the business unsure whether it had been paid.
  const gate = await approvals.approvalRequired(db, from, amountCents);
  if (gate) {
    throw new DebitError(
      "NEEDS_APPROVAL",
      "That account requires manual approval for an amount this size, so it cannot be collected automatically."
    );
  }

  const uniqueRef = `dd:${mandateId}:${String(reference).slice(0, 60)}`;

  const seen = await db
    .prepare(`SELECT id FROM direct_debit_pulls WHERE reference = ?`)
    .bind(uniqueRef)
    .first();
  if (seen) return { collected: false, duplicate: true };

  let res;
  try {
    res = await ledger.transferInternal(db, {
      fromAccountId: dd.from_account_id,
      toAccountId: dd.to_account_id,
      amountCents,
      memo: memo || dd.reference || "Direct debit",
      byUserId: actor.id,
      reference: uniqueRef,
    });
  } catch (err) {
    throw new DebitError("FAILED", `Could not collect: ${err.message}`);
  }

  await db
    .prepare(
      `INSERT OR IGNORE INTO direct_debit_pulls (direct_debit_id, amount_cents, entry_id, reference)
       VALUES (?, ?, ?, ?)`
    )
    .bind(mandateId, amountCents, res.entryId, uniqueRef)
    .run();

  await db
    .prepare(
      `UPDATE direct_debits
          SET last_pulled_at = datetime('now'), total_pulled_cents = total_pulled_cents + ?
        WHERE id = ?`
    )
    .bind(amountCents, mandateId)
    .run();

  await ledger.audit(db, {
    actorId: actor.id,
    action: "directdebit.collected",
    targetType: "direct_debit",
    targetId: mandateId,
    detail: `${amountCents} cents, ref ${reference}`,
  });

  // Best effort notification. bizhooks never throws, so a broken webhook
  // cannot undo a collection that has already been committed.
  await bizhooks.fire(db, dd.business_id, "direct_debit.collected", {
    mandate_id: mandateId,
    reference,
    ...bizhooks.amountFields(amountCents),
  });

  return { collected: true, entryId: res.entryId };
}

// ---------------------------------------------------------------------------
// listings
// ---------------------------------------------------------------------------
/** What this person is paying out. */
export async function listForPayer(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT d.*, b.display_name AS company, b.firm_name, a.label AS from_label
         FROM direct_debits d
         JOIN accounts a ON a.id = d.from_account_id
    LEFT JOIN businesses b ON b.id = d.business_id
        WHERE a.owner_user_id = ? AND d.status = 'active'
        ORDER BY d.id DESC`
    )
    .bind(userId)
    .all();
  return results;
}

/** What this company is collecting. */
export async function listForBusiness(db, businessId) {
  const { results } = await db
    .prepare(
      `SELECT d.*, u.mc_username, u.discord_username
         FROM direct_debits d
         JOIN accounts a ON a.id = d.from_account_id
         JOIN users u ON u.id = a.owner_user_id
        WHERE d.business_id = ? AND d.status = 'active'
        ORDER BY d.id DESC`
    )
    .bind(businessId)
    .all();
  return results;
}

export async function pullHistory(db, mandateId, limit = 20) {
  const { results } = await db
    .prepare(`SELECT * FROM direct_debit_pulls WHERE direct_debit_id = ? ORDER BY id DESC LIMIT ?`)
    .bind(mandateId, limit)
    .all();
  return results;
}
