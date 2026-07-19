// ledger.js — double-entry engine for Z&E Bank.
// ===========================================================================
// Every movement of money is an ENTRY containing two or more POSTINGS whose
// amounts sum to exactly zero. Money is never created or destroyed by a
// posting; it only moves between accounts. If you want money to enter the
// system, it comes from an internal account, and that account goes negative —
// visibly, on the books.
//
// Three rules, enforced rather than documented:
//
//   1. Postings in an entry sum to zero.        (checked here, re-checked by
//                                                reconciliation)
//   2. Every entry has a UNIQUE idempotency key. (database constraint)
//   3. Non-negative accounts cannot go negative. (database CHECK constraint)
//
// Rule 3 is why overdraft protection is trustworthy: the balance is not read,
// judged, and then written in separate steps that could interleave. The
// constraint fails the write itself.
// ===========================================================================

import { assertCents, sumCents, toCents } from "./money.js";

export const POOL_ACCOUNT_ID = 1;      // mirrors real Treasury funds
export const EQUITY_ACCOUNT_ID = 2;    // bank's own capital
export const SUSPENSE_ACCOUNT_ID = 3;  // in flight / unattributed

// ---------------------------------------------------------------------------
// postEntry — the ONLY way money moves. Nothing else writes to postings or
// touches accounts.balance_cents.
// ---------------------------------------------------------------------------
/**
 * @param db   D1 database
 * @param kind one of the entries.kind CHECK values
 * @param idempotencyKey  MUST be derived from the thing being recorded
 *        (treasury posting id, withdrawal id, account+period), never random.
 *        Reusing a key is how a retry stays safe.
 * @param postings [{ accountId, amountCents }] — must sum to 0
 *
 * @returns { entryId, duplicate }  duplicate=true means this exact operation
 *          was already applied and nothing changed. Callers should treat that
 *          as success, not as an error.
 */
export async function postEntry(db, { kind, memo = null, idempotencyKey, createdBy = null, postings }) {
  if (!idempotencyKey || typeof idempotencyKey !== "string") {
    throw new Error("ledger: idempotencyKey is required");
  }
  if (!Array.isArray(postings) || postings.length < 2) {
    throw new Error("ledger: an entry needs at least two postings");
  }

  for (const p of postings) {
    assertCents(p.amountCents);
    if (p.amountCents === 0) throw new Error("ledger: zero-amount posting");
    if (!Number.isInteger(p.accountId)) throw new Error("ledger: bad accountId");
  }

  // Rule 1. If this ever fails, the caller's arithmetic is wrong and we stop
  // before touching the database.
  const total = sumCents(postings.map((p) => p.amountCents));
  if (total !== 0) {
    throw new Error(`ledger: postings do not balance (sum ${total}, must be 0)`);
  }

  // Fast path: already applied? Cheap read, avoids a doomed write.
  const existing = await getEntryByKey(db, idempotencyKey);
  if (existing) return { entryId: existing.id, duplicate: true };

  // Insert header, postings, and balance updates as ONE atomic batch. D1 runs
  // a batch in an implicit transaction: if any statement fails — including the
  // overdraft CHECK or the UNIQUE key — none of it is applied.
  const statements = [
    db.prepare(
      `INSERT INTO entries (kind, memo, idempotency_key, created_by) VALUES (?, ?, ?, ?)`
    ).bind(kind, memo, idempotencyKey, createdBy),
  ];

  for (const p of postings) {
    statements.push(
      db.prepare(
        `INSERT INTO postings (entry_id, account_id, amount_cents)
         VALUES ((SELECT id FROM entries WHERE idempotency_key = ?), ?, ?)`
      ).bind(idempotencyKey, p.accountId, p.amountCents)
    );
    statements.push(
      db.prepare(
        `UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?`
      ).bind(p.amountCents, p.accountId)
    );
  }

  try {
    await db.batch(statements);
  } catch (err) {
    const msg = String(err && err.message);

    // Lost a race with an identical request — the other one won, which is
    // exactly what idempotency is for.
    if (/UNIQUE/i.test(msg) && /idempotency_key/i.test(msg)) {
      const now = await getEntryByKey(db, idempotencyKey);
      if (now) return { entryId: now.id, duplicate: true };
    }

    // Rule 3 fired: someone tried to spend money that isn't there.
    if (/CHECK/i.test(msg)) {
      throw new LedgerError("INSUFFICIENT_FUNDS", "Not enough money in that account.");
    }
    throw err;
  }

  const created = await getEntryByKey(db, idempotencyKey);
  return { entryId: created ? created.id : null, duplicate: false };
}

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------
export async function getEntryByKey(db, idempotencyKey) {
  return await db.prepare(`SELECT * FROM entries WHERE idempotency_key = ?`).bind(idempotencyKey).first();
}

export async function getAccount(db, id) {
  return await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first();
}

export async function listUserAccounts(db, userId) {
  const { results } = await db
    .prepare(`SELECT * FROM accounts WHERE owner_user_id = ? AND status <> 'closed' ORDER BY id`)
    .bind(userId)
    .all();
  return results;
}

/** Balance recomputed from postings — the authoritative number. */
export async function derivedBalance(db, accountId) {
  const r = await db
    .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM postings WHERE account_id = ?`)
    .bind(accountId)
    .first();
  return r ? r.total : 0;
}

export async function accountStatement(db, accountId, { limit = 50, before = null } = {}) {
  const sql = before
    ? `SELECT p.*, e.kind, e.memo, e.created_at AS entry_at
       FROM postings p JOIN entries e ON e.id = p.entry_id
       WHERE p.account_id = ? AND p.id < ? ORDER BY p.id DESC LIMIT ?`
    : `SELECT p.*, e.kind, e.memo, e.created_at AS entry_at
       FROM postings p JOIN entries e ON e.id = p.entry_id
       WHERE p.account_id = ? ORDER BY p.id DESC LIMIT ?`;
  const stmt = before
    ? db.prepare(sql).bind(accountId, before, limit)
    : db.prepare(sql).bind(accountId, limit);
  const { results } = await stmt.all();
  return results;
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------
/** 16 hex chars — long enough that codes can't be guessed or mistyped into
 *  someone else's account, short enough to retype in a Minecraft chat box. */
export function generateDepositCode() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function openAccount(db, { userId, kind = "checking", label = null, interestBps = 0 }) {
  if (!["checking", "savings"].includes(kind)) throw new Error("ledger: bad account kind");
  const r = await db
    .prepare(
      `INSERT INTO accounts (owner_user_id, kind, label, interest_bps, allow_negative, deposit_code)
       VALUES (?, ?, ?, ?, 0, ?)`
    )
    .bind(userId, kind, label || (kind === "savings" ? "Savings" : "Checking"), interestBps, generateDepositCode())
    .run();
  return r.meta.last_row_id;
}

export async function getAccountByDepositCode(db, code) {
  if (!code) return null;
  return await db.prepare(`SELECT * FROM accounts WHERE deposit_code = ?`).bind(code).first();
}

/** Where a deposit goes when we know the player but not the account. */
export async function defaultAccountForUser(db, userId) {
  return await db
    .prepare(
      `SELECT * FROM accounts
       WHERE owner_user_id = ? AND kind = 'checking' AND status = 'active'
       ORDER BY id LIMIT 1`
    )
    .bind(userId)
    .first();
}

/**
 * Freezing blocks money moving in OR out. It cannot be a database constraint
 * because it depends on the operation, so every money path calls this first.
 */
export function assertUsable(account) {
  if (!account) throw new LedgerError("NO_ACCOUNT", "Account not found.");
  if (account.status === "frozen") {
    throw new LedgerError("FROZEN", "This account is frozen pending review.");
  }
  if (account.status === "closed") {
    throw new LedgerError("CLOSED", "This account is closed.");
  }
  return account;
}

export async function setAccountStatus(db, accountId, status) {
  if (!["active", "frozen", "closed"].includes(status)) throw new Error("ledger: bad status");
  await db.prepare(`UPDATE accounts SET status = ? WHERE id = ?`).bind(status, accountId).run();
}

// ---------------------------------------------------------------------------
// internal transfer — player to player, no Treasury round-trip.
// Both sides are our own liability accounts, so the pool never moves and this
// is instant and free.
// ---------------------------------------------------------------------------
export async function transferInternal(db, { fromAccountId, toAccountId, amountCents, memo, byUserId, reference }) {
  assertCents(amountCents);
  if (amountCents <= 0) throw new LedgerError("BAD_AMOUNT", "Amount must be positive.");
  if (fromAccountId === toAccountId) throw new LedgerError("SAME_ACCOUNT", "Pick a different account.");

  const [from, to] = await Promise.all([getAccount(db, fromAccountId), getAccount(db, toAccountId)]);
  assertUsable(from);
  assertUsable(to);

  // Advisory pre-check for a friendly error. The DB CHECK is the real guard —
  // this balance could be stale by the time the batch runs, and that's fine.
  if (!from.allow_negative && from.balance_cents < amountCents) {
    throw new LedgerError("INSUFFICIENT_FUNDS", "Not enough money in that account.");
  }

  return await postEntry(db, {
    kind: "transfer",
    memo: memo || null,
    idempotencyKey: reference || `transfer:${crypto.randomUUID()}`,
    createdBy: byUserId ?? null,
    postings: [
      { accountId: fromAccountId, amountCents: -amountCents },
      { accountId: toAccountId, amountCents: amountCents },
    ],
  });
}

// ---------------------------------------------------------------------------
// solvency
// ---------------------------------------------------------------------------
/**
 * What the bank owes customers, what it actually holds, and what an admin may
 * safely take out.
 *
 * `treasuryCents` is the REAL pool balance read from the Treasury API — not
 * our own book value. Comparing the two is the whole point: if our books say
 * one thing and the Treasury says another, we want to know immediately.
 */
export async function solvency(db, treasuryCents) {
  const liab = await db
    .prepare(
      `SELECT COALESCE(SUM(balance_cents), 0) AS total FROM accounts
       WHERE kind IN ('checking','savings')`
    )
    .first();
  const liabilities = liab ? liab.total : 0;

  const ratioBps = parseInt(await getSetting(db, "reserve_ratio_bps", "10000"), 10);
  const reserveFloor = Math.ceil((liabilities * ratioBps) / 10000);
  const equity = treasuryCents - liabilities;
  const safeToWithdraw = Math.max(0, treasuryCents - reserveFloor);

  return {
    treasuryCents,
    liabilities,
    equity,
    reserveRatioBps: ratioBps,
    reserveFloor,
    safeToWithdraw,
    // Below the floor the bank cannot honour withdrawals in full. Loud, not subtle.
    underReserved: treasuryCents < reserveFloor,
  };
}

// ---------------------------------------------------------------------------
// integrity — used by the reconciliation job and callable from admin.
// ---------------------------------------------------------------------------
export async function findUnbalancedEntries(db) {
  const { results } = await db
    .prepare(
      `SELECT entry_id, SUM(amount_cents) AS drift FROM postings
       GROUP BY entry_id HAVING SUM(amount_cents) <> 0`
    )
    .all();
  return results;
}

/** Accounts whose cached balance disagrees with the sum of their postings. */
export async function findBalanceMismatches(db) {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.label, a.balance_cents,
              COALESCE((SELECT SUM(p.amount_cents) FROM postings p WHERE p.account_id = a.id), 0) AS derived
       FROM accounts a
       WHERE a.balance_cents <> COALESCE(
         (SELECT SUM(p.amount_cents) FROM postings p WHERE p.account_id = a.id), 0)`
    )
    .all();
  return results;
}

/**
 * Repair a cached balance from its postings. Deliberately NOT automatic — a
 * mismatch means something upstream is wrong, and silently papering over it
 * destroys the evidence. An admin runs this after the cause is understood.
 */
export async function rebuildBalance(db, accountId) {
  const derived = await derivedBalance(db, accountId);
  await db.prepare(`UPDATE accounts SET balance_cents = ? WHERE id = ?`).bind(derived, accountId).run();
  return derived;
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
export async function getSetting(db, key, fallback = null) {
  const r = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first();
  return r ? r.value : fallback;
}

export async function setSetting(db, key, value, byUserId = null) {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_by, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`
    )
    .bind(key, String(value), byUserId)
    .run();
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------
export async function audit(db, { actorId = null, action, targetType = null, targetId = null, detail = null, ip = null }) {
  await db
    .prepare(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(actorId, action, targetType, targetId == null ? null : String(targetId), detail, ip)
    .run();
}

// Re-exported so callers doing ledger work don't import from two places.
export { toCents };
