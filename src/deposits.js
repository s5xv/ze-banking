// deposits.js - real money arriving in the Treasury pool.
// ===========================================================================
// SIGN CONVENTION (important, and slightly counter-intuitive):
//
//   Customer accounts hold POSITIVE balances - "you have 500".
//   The internal pool account goes NEGATIVE as claims are issued against it.
//
//   Deposit  500:  customer +500,  pool -500   (sums to 0)
//   Withdraw 500:  customer -500,  pool +500   (sums to 0)
//
// So `-pool.balance_cents` is the net real money that has flowed through the
// bank, and it should equal the Treasury pool balance. Reconciliation checks
// exactly that. The alternative (assets positive / liabilities negative) is
// more orthodox accounting but would make every customer balance display as a
// negative number, which is a worse trade.
//
// IDEMPOTENCY: `deposits.treasury_posting_id` is UNIQUE and is the Treasury's
// per-account `postingId`. The webhook and the cursor poller both run, and a
// deposit seen by both is credited exactly once.
// ===========================================================================

import * as ledger from "./ledger.js";
import * as treasury from "./treasury.js";
import { tryCompleteVerification } from "./auth.js";

// Deposit codes are 16 hex chars. Players paste them into a /pay memo along
// with whatever else they type, so we extract rather than compare.
const CODE_RE = /\b[0-9a-f]{16}\b/i;
const VERIFY_RE = /\bVERIFY-[0-9A-F]{12}\b/i;

/**
 * Work out which account a payment belongs to.
 *   1. A deposit code in the memo - explicit, wins over everything.
 *   2. The paying player's verified Minecraft uuid -> their checking account.
 *   3. Nothing. Money is real but unattributable; it goes to suspense and an
 *      admin resolves it. It is NEVER dropped or auto-assigned.
 */
async function resolveTarget(db, item) {
  const text = `${item.memo || ""} ${item.message || ""}`;
  const match = text.match(CODE_RE);
  if (match) {
    const acct = await ledger.getAccountByDepositCode(db, match[0].toLowerCase());
    if (acct && acct.status !== "closed") return { account: acct, how: "code" };
  }

  if (item.initiatorUuid) {
    const user = await db
      .prepare(`SELECT * FROM users WHERE mc_uuid = ? AND mc_verified_at IS NOT NULL`)
      .bind(item.initiatorUuid)
      .first();
    if (user) {
      const acct = await ledger.defaultAccountForUser(db, user.id);
      if (acct) return { account: acct, how: "uuid" };
    }
  }

  return { account: null, how: "unmatched" };
}

/**
 * Credit one Treasury posting. Safe to call repeatedly with the same posting -
 * the UNIQUE constraint makes the second call a no-op.
 *
 * @returns { credited: boolean, duplicate: boolean, accountId, reason }
 */
export async function creditPosting(db, item, { source = "feed" } = {}) {
  // Only money ARRIVING. A negative posting is money leaving the pool (i.e. a
  // withdrawal we made); crediting it would invent money.
  if (!item.amountCents || item.amountCents <= 0) {
    return { credited: false, duplicate: false, reason: "not-inbound" };
  }
  if (!item.postingId) {
    return { credited: false, duplicate: false, reason: "no-posting-id" };
  }

  const already = await db
    .prepare(`SELECT id, account_id FROM deposits WHERE treasury_posting_id = ?`)
    .bind(item.postingId)
    .first();
  if (already) {
    return { credited: false, duplicate: true, accountId: already.account_id, reason: "already-credited" };
  }

  // A verification payment proves ownership AND is still real money, so it
  // gets credited like any other deposit. Run this BEFORE resolving the
  // target: verifying links the uuid to a user, which is often what lets the
  // deposit find an account at all.
  const text = `${item.memo || ""} ${item.message || ""}`;
  const vmatch = text.match(VERIFY_RE);
  if (vmatch) {
    try {
      await tryCompleteVerification(db, {
        code: vmatch[0].toUpperCase(),
        payerUuid: item.initiatorUuid,
      });
    } catch (err) {
      // Verification failing must never block crediting real money.
      await ledger.audit(db, {
        action: "verification.error",
        targetType: "posting",
        targetId: item.postingId,
        detail: err.message,
      });
    }
  }

  const { account, how } = await resolveTarget(db, item);

  // Frozen accounts don't take deposits either - the money is held in suspense
  // so it isn't stuck inside an account nobody can touch.
  const usable = account && account.status === "active";
  const targetId = usable ? account.id : ledger.SUSPENSE_ACCOUNT_ID;

  const entryKey = `deposit:${item.postingId}`;
  let entryId = null;
  try {
    const res = await ledger.postEntry(db, {
      kind: "deposit",
      memo: item.memo || null,
      idempotencyKey: entryKey,
      postings: [
        { accountId: targetId, amountCents: item.amountCents },
        { accountId: ledger.POOL_ACCOUNT_ID, amountCents: -item.amountCents },
      ],
    });
    entryId = res.entryId;
  } catch (err) {
    // Money genuinely arrived, so failing to book it is not acceptable - leave
    // a trace for the admin rather than swallowing it.
    await ledger.audit(db, {
      action: "deposit.failed",
      targetType: "posting",
      targetId: item.postingId,
      detail: err.message,
    });
    throw err;
  }

  await db
    .prepare(
      `INSERT OR IGNORE INTO deposits
         (treasury_posting_id, treasury_txn_id, account_id, entry_id, amount_cents,
          memo, payer_uuid, status, source, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      item.postingId,
      item.txnId,
      usable ? account.id : null,
      entryId,
      item.amountCents,
      item.memo || null,
      item.initiatorUuid || null,
      usable ? "credited" : "unmatched",
      source,
      item.settledAt
    )
    .run();

  return {
    credited: true,
    duplicate: false,
    accountId: usable ? account.id : null,
    reason: usable ? how : "suspense",
  };
}

/**
 * Drain the Treasury feed from our stored cursor.
 *
 * The cursor only advances after a page is fully processed, so a crash
 * mid-page re-reads it next run - which is harmless, because every credit is
 * idempotent on postingId. Losing a deposit is unacceptable; re-reading one
 * costs nothing.
 */
export async function ingestFeed(env, db, { maxPages = 20 } = {}) {
  const row = await db.prepare(`SELECT cursor FROM ledger_cursor WHERE id = 1`).first();
  let cursor = row ? row.cursor : 0;

  let credited = 0;
  let skipped = 0;
  let unmatched = 0;
  let pages = 0;

  while (pages < maxPages) {
    const feed = await treasury.fetchFeed(env, cursor, 200);

    // Unreadable postings are logged rather than dropped quietly, but they do
    // not stop the rest of the batch being credited.
    for (const t of feed.bad || []) {
      await ledger.audit(db, {
        action: "deposit.unreadable",
        targetType: "posting",
        targetId: t.postingId || "unknown",
        detail: `amount=${t.rawAmount} memo=${String(t.memo || "").slice(0, 60)}`,
      });
    }

    if (!feed.items.length && !(feed.bad || []).length) {
      cursor = feed.nextCursor ?? cursor;
      break;
    }

    for (const item of feed.items) {
      const res = await creditPosting(db, item, { source: "feed" });
      if (res.credited) {
        credited++;
        if (res.reason === "suspense") unmatched++;
      } else {
        skipped++;
      }
    }

    cursor = feed.nextCursor;
    await db
      .prepare(`UPDATE ledger_cursor SET cursor = ?, updated_at = datetime('now') WHERE id = 1`)
      .bind(cursor)
      .run();

    pages++;
    if (!feed.hasMore) break;
  }

  return { credited, skipped, unmatched, cursor, pages };
}

/**
 * Webhook receiver.
 *
 * Deliberately does NOT trust the payload's amounts. A push just means
 * "something happened" - we then pull the authoritative feed. That way there
 * is exactly one code path that can create money, and forging a webhook body
 * can't credit anyone. The signature check still matters (it stops randoms
 * making us hammer the API), but it isn't load-bearing for correctness.
 */
export async function handleWebhook(env, db, request) {
  const secret = env.WEBHOOK_SECRET;
  if (!secret) return { ok: false, error: "webhook secret not configured", status: 500 };

  const raw = await request.text();
  const signature =
    request.headers.get("x-signature") ||
    request.headers.get("x-webhook-signature") ||
    request.headers.get("x-hub-signature-256") ||
    "";

  const valid = await verifySignature(secret, raw, signature);
  if (!valid) return { ok: false, error: "bad signature", status: 401 };

  const result = await ingestFeed(env, db, { maxPages: 3 });
  return { ok: true, status: 200, ...result };
}

async function verifySignature(secret, body, signature) {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  const given = signature.replace(/^sha256=/, "").trim().toLowerCase();

  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** Admin: move a suspense deposit to its rightful account once identified. */
export async function assignUnmatched(db, depositId, accountId, adminUserId) {
  const dep = await db.prepare(`SELECT * FROM deposits WHERE id = ?`).bind(depositId).first();
  if (!dep) throw new Error("deposit not found");
  if (dep.status !== "unmatched") throw new Error("that deposit is already assigned");

  const acct = await ledger.getAccount(db, accountId);
  ledger.assertUsable(acct);

  await ledger.postEntry(db, {
    kind: "adjustment",
    memo: `Assign unmatched deposit #${depositId}`,
    idempotencyKey: `deposit-assign:${depositId}`,
    createdBy: adminUserId,
    postings: [
      { accountId: ledger.SUSPENSE_ACCOUNT_ID, amountCents: -dep.amount_cents },
      { accountId, amountCents: dep.amount_cents },
    ],
  });

  await db
    .prepare(`UPDATE deposits SET account_id = ?, status = 'credited' WHERE id = ?`)
    .bind(accountId, depositId)
    .run();

  await ledger.audit(db, {
    actorId: adminUserId,
    action: "deposit.assigned",
    targetType: "deposit",
    targetId: depositId,
    detail: `to account ${accountId}`,
  });
}

export async function listUnmatched(db) {
  const { results } = await db
    .prepare(`SELECT * FROM deposits WHERE status = 'unmatched' ORDER BY id DESC LIMIT 100`)
    .all();
  return results;
}
