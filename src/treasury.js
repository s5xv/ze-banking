// treasury.js - client for the DemocracyCraft Treasury REST API.
// ===========================================================================
// Base: https://api.democracycraft.net/economy
// Auth: BUSINESS-scope JWT issued in-game with `/treasuryapi business issue`.
//       The JWT carries a `firm` claim; `fromAccountId` selects which firm
//       account to debit, and firm ownership is verified server-side.
//
// >>> THIS KEY CAN MOVE EVERY COIN THE BANK HOLDS. <<<
// It lives only as a Worker secret, never in the repo, and is rotated via
// /api/v1/auth/rotate if there is any doubt about it.
//
//   npx wrangler secret put DC_API_TOKEN
//   npx wrangler secret put POOL_ACCOUNT_ID     # firm account holding funds
//
// Money crosses this boundary as decimal STRINGS in both directions. It is
// converted to integer cents the moment it arrives and back to a string the
// moment it leaves. See money.js for why.
// ===========================================================================

import { toCents, fromCents } from "./money.js";

const DEFAULT_BASE = "https://api.democracycraft.net/economy";
const base = (env) => env.DC_API_BASE || DEFAULT_BASE;

export class TreasuryError extends Error {
  constructor(code, message, status = 0, retryable = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

// The API's error envelope is flat: { error: "SNAKE_CASE_CODE", message: "..." }
// The code is stable across versions; the message is informational only, so we
// branch on the code and only ever show the message to admins.
async function request(env, path, { method = "GET", body = null, headers = {}, timeoutMs = 10000 } = {}) {
  const jwt = env.DC_API_TOKEN;
  if (!jwt) throw new TreasuryError("NO_TOKEN", "DC_API_TOKEN is not configured", 0, false);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${base(env)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    // Network failure or timeout. We do NOT know whether the server processed
    // it. For reads that's harmless; for transfers the caller must treat this
    // as UNKNOWN and never as "didn't happen".
    throw new TreasuryError("UNREACHABLE", `Treasury unreachable: ${err.message}`, 0, true);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") || 5);
    throw new TreasuryError("RATE_LIMITED", `Rate limited; retry in ${retryAfter}s`, 429, true);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // 5xx: the server may or may not have applied it - retryable, but only
    // with the same Idempotency-Key.
    const retryable = res.status >= 500;
    throw new TreasuryError(
      data.error || `HTTP_${res.status}`,
      data.message || `Treasury HTTP ${res.status}`,
      res.status,
      retryable
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// identity / accounts
// ---------------------------------------------------------------------------
export async function whoami(env) {
  return await request(env, "/api/v1/auth/me");
}

/** Resolve a Minecraft name or uuid -> { accountId, playerUuid, playerName }. */
export async function accountForPlayer(env, { name = null, uuid = null }) {
  const q = uuid ? `uuid=${encodeURIComponent(uuid)}` : `name=${encodeURIComponent(name)}`;
  try {
    return await request(env, `/api/v1/accounts/by-player?${q}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Pool balance in integer cents - the bank's real assets. */
export async function poolBalanceCents(env) {
  const id = env.POOL_ACCOUNT_ID;
  if (!id) throw new TreasuryError("NO_POOL", "POOL_ACCOUNT_ID is not configured", 0, false);
  const d = await request(env, `/api/v1/accounts/${encodeURIComponent(id)}/balance`);
  const cents = toCents(d.balance);
  if (cents === null) throw new TreasuryError("BAD_AMOUNT", `Unparseable balance: ${d.balance}`);
  return cents;
}

// ---------------------------------------------------------------------------
// transaction feed - cursor based, so ingestion never has gaps.
// ---------------------------------------------------------------------------
/**
 * Pull postings after `cursor`. Returns { items, nextCursor, hasMore }.
 *
 * Each item: { postingId, txnId, amount, memo, message, settledAt,
 *              initiatorUuid, pluginSystem }
 *
 * postingId is per-account and unique - the correct idempotency key. txnId is
 * shared by both legs of a transfer and would collide.
 *
 * amountCents is signed: positive is money arriving in the pool, negative is
 * money leaving. Deposits must only ever be credited from positive postings.
 */
export async function fetchFeed(env, cursor = 0, limit = 200) {
  const id = env.POOL_ACCOUNT_ID;
  if (!id) throw new TreasuryError("NO_POOL", "POOL_ACCOUNT_ID is not configured", 0, false);

  const d = await request(
    env,
    `/api/v1/accounts/${encodeURIComponent(id)}/transactions/feed?since=${cursor}&limit=${limit}`
  );

  const items = (d.items || []).map((t) => ({
    postingId: t.postingId != null ? String(t.postingId) : null,
    txnId: t.txnId != null ? String(t.txnId) : null,
    amountCents: toCents(t.amount),
    rawAmount: t.amount,
    memo: t.memo || "",
    message: t.message || "",
    settledAt: t.settledAt || null,
    initiatorUuid: t.initiatorUuid || null,
    pluginSystem: t.pluginSystem || null,
  }));

  // A posting we can't parse must not be silently skipped - that would be
  // real money the books never see.
  const bad = items.filter((t) => t.amountCents === null || !t.postingId);
  if (bad.length) {
    throw new TreasuryError(
      "BAD_FEED_ITEM",
      `Feed returned ${bad.length} unparseable posting(s); refusing to process the batch`
    );
  }

  return { items, nextCursor: d.nextCursor ?? cursor, hasMore: !!d.hasMore };
}

/** Paged history, for admin browsing rather than ingestion. */
export async function fetchTransactions(env, { page = 1, limit = 50 } = {}) {
  const id = env.POOL_ACCOUNT_ID;
  const d = await request(
    env,
    `/api/v1/accounts/${encodeURIComponent(id)}/transactions?page=${page}&limit=${limit}`
  );
  return d;
}

// ---------------------------------------------------------------------------
// transfers - money leaving the bank
// ---------------------------------------------------------------------------
/**
 * Pay a player from the pool.
 *
 * `idempotencyKey` is REQUIRED and must be stored by the caller BEFORE this is
 * called. On a timeout or 5xx the outcome is unknown; re-sending the SAME key
 * returns the original result instead of paying a second time. Sending a fresh
 * key on retry is how a bank pays twice.
 *
 * Throws TreasuryError with `.retryable` set. Callers must distinguish:
 *   retryable === false -> it definitively did not happen; safe to reverse
 *   retryable === true  -> UNKNOWN; park as needs_review, never auto-reverse
 */
export async function payPlayer(env, { toPlayerUuid, toPlayerName, amountCents, memo, idempotencyKey }) {
  if (!idempotencyKey) throw new TreasuryError("NO_IDEMPOTENCY_KEY", "Refusing to transfer without an idempotency key", 0, false);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new TreasuryError("BAD_AMOUNT", "Transfer amount must be positive integer cents", 0, false);
  }

  const body = {
    fromAccountId: Number(env.POOL_ACCOUNT_ID),
    amount: fromCents(amountCents), // decimal string, never a number
    memo: memo || "",
  };
  if (toPlayerUuid) body.toPlayerUuid = toPlayerUuid;
  else if (toPlayerName) body.toPlayerName = toPlayerName;
  else throw new TreasuryError("NO_RECIPIENT", "Need a player uuid or name", 0, false);

  const d = await request(env, "/api/v1/transfers/to-player", {
    method: "POST",
    body,
    headers: { "Idempotency-Key": idempotencyKey },
  });

  return {
    txnId: d.txnId != null ? String(d.txnId) : null,
    amountCents: toCents(d.amount),
    settledAt: d.settledAt || null,
  };
}

/** Pay another firm - used later for business payouts. */
export async function payFirm(env, { toFirm, amountCents, memo, idempotencyKey }) {
  if (!idempotencyKey) throw new TreasuryError("NO_IDEMPOTENCY_KEY", "Refusing to transfer without an idempotency key", 0, false);
  const d = await request(env, "/api/v1/transfers/to-firm", {
    method: "POST",
    body: {
      fromAccountId: Number(env.POOL_ACCOUNT_ID),
      toFirm,
      amount: fromCents(amountCents),
      memo: memo || "",
    },
    headers: { "Idempotency-Key": idempotencyKey },
  });
  return { txnId: d.txnId != null ? String(d.txnId) : null, settledAt: d.settledAt || null };
}

// ---------------------------------------------------------------------------
// webhooks - push notification of deposits, so players don't wait on a poll.
// The cursor feed still runs as the safety net; both are idempotent on
// postingId, so a deposit seen twice is credited once.
// ---------------------------------------------------------------------------
export async function registerWebhook(env, url) {
  return await request(env, "/api/v1/webhooks", { method: "POST", body: { url } });
}

export async function listWebhooks(env) {
  return await request(env, "/api/v1/webhooks");
}

export async function deleteWebhook(env, id) {
  return await request(env, `/api/v1/webhooks/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// rate limiting
// ---------------------------------------------------------------------------
// BUSINESS keys get 120 transfers/min. A payroll run or a monthly interest
// sweep will exceed that, so bulk work must be queued and drained, not looped.
// This helper retries only errors flagged retryable, with backoff.
export async function withRetry(fn, { attempts = 3, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof TreasuryError) || !err.retryable) throw err;
      if (i === attempts - 1) break;
      const delay = baseDelayMs * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
