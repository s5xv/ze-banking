// bizhooks.js - webhooks for companies. The Platinum "webhook integration" perk.
// ===========================================================================
// When money moves on a company account we POST a signed JSON payload to a URL
// the company controls, so they can wire the bank into their own Discord bot,
// shop system, or spreadsheet.
//
// THREE RULES, all of which exist because an outbound HTTP call to a URL a
// customer typed in is not something the bank should depend on:
//
//   1. A webhook failing must NEVER fail the payment that triggered it.
//      Delivery is wrapped so any error, timeout, or garbage response is
//      swallowed. Money moving is the important part; telling someone about it
//      is not.
//
//   2. Delivery is time limited. A company pointing us at a URL that hangs
//      would otherwise stall a payroll run.
//
//   3. Repeated failures disable the webhook rather than retrying forever.
//      A dead URL should stop costing us requests, and the company can see the
//      failure count and last error on their page.
//
// Payloads are signed with HMAC-SHA256 using a per-webhook secret, so the
// receiver can prove the call came from us rather than from anyone who guessed
// the URL.
// ===========================================================================

import * as biz from "./business.js";
import * as ledger from "./ledger.js";
import { fromCents } from "./money.js";

const DELIVERY_TIMEOUT_MS = 4000;
const DISABLE_AFTER_FAILURES = 10;

function randomSecret() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// management
// ---------------------------------------------------------------------------
export async function register(db, business, actor, url) {
  const tier = biz.effectiveTier(business);
  if (!tier.webhooks) {
    throw new Error("Webhooks are a Platinum feature.");
  }

  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    // Plain HTTP would send a signed payload about someone's money in clear
    // text across the network.
    throw new Error("The URL must start with https.");
  }

  const existing = await db
    .prepare(`SELECT COUNT(*) AS n FROM business_webhooks WHERE business_id = ? AND active = 1`)
    .bind(business.id)
    .first();
  if (existing && existing.n >= 3) throw new Error("A company can have at most 3 webhooks.");

  const secret = randomSecret();
  const r = await db
    .prepare(`INSERT INTO business_webhooks (business_id, url, secret) VALUES (?, ?, ?)`)
    .bind(business.id, parsed.toString(), secret)
    .run();

  await ledger.audit(db, {
    actorId: actor.id,
    action: "bizhook.registered",
    targetType: "business",
    targetId: business.id,
    detail: parsed.host,
  });

  // Returned once so the company can store it. It stays readable on their own
  // page, because unlike a bank credential this only lets them verify our
  // calls, not move money.
  return { id: r.meta.last_row_id, secret };
}

export async function list(db, businessId) {
  const { results } = await db
    .prepare(`SELECT * FROM business_webhooks WHERE business_id = ? ORDER BY id`)
    .bind(businessId)
    .all();
  return results;
}

export async function remove(db, business, actor, id) {
  await db
    .prepare(`DELETE FROM business_webhooks WHERE id = ? AND business_id = ?`)
    .bind(id, business.id)
    .run();
  await ledger.audit(db, {
    actorId: actor.id,
    action: "bizhook.removed",
    targetType: "business",
    targetId: business.id,
    detail: String(id),
  });
}

export async function reactivate(db, business, id) {
  await db
    .prepare(`UPDATE business_webhooks SET active = 1, failures = 0, last_error = NULL
               WHERE id = ? AND business_id = ?`)
    .bind(id, business.id)
    .run();
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------
async function sign(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Send one event to every active webhook for a company.
 *
 * Never throws. Callers can await it or not; either way the payment that
 * triggered it is already committed and is not affected by what happens here.
 */
export async function fire(db, businessId, event, data) {
  try {
    const { results: hooks } = await db
      .prepare(`SELECT * FROM business_webhooks WHERE business_id = ? AND active = 1`)
      .bind(businessId)
      .all();
    if (!hooks.length) return;

    const body = JSON.stringify({
      event,
      business_id: businessId,
      sent_at: new Date().toISOString(),
      data,
    });

    for (const hook of hooks) {
      try {
        const signature = await sign(hook.secret, body);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

        let res;
        try {
          res = await fetch(hook.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-ze-event": event,
              "x-ze-signature": `sha256=${signature}`,
            },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (res.ok) {
          if (hook.failures > 0) {
            await db
              .prepare(`UPDATE business_webhooks SET failures = 0, last_error = NULL WHERE id = ?`)
              .bind(hook.id)
              .run();
          }
        } else {
          await recordFailure(db, hook, `HTTP ${res.status}`);
        }
      } catch (err) {
        await recordFailure(db, hook, String(err.message).slice(0, 120));
      }
    }
  } catch {
    // Even the lookup failing must not disturb the caller.
  }
}

async function recordFailure(db, hook, reason) {
  const failures = (hook.failures || 0) + 1;
  const disable = failures >= DISABLE_AFTER_FAILURES;
  await db
    .prepare(`UPDATE business_webhooks SET failures = ?, last_error = ?, active = ? WHERE id = ?`)
    .bind(failures, reason, disable ? 0 : 1, hook.id)
    .run();
}

/**
 * Convenience: fire only if the account belongs to a company.
 * Used from money paths that do not know whether they are dealing with a
 * company or a person.
 */
export async function fireForAccount(db, accountId, event, data) {
  try {
    const account = await ledger.getAccount(db, accountId);
    if (!account || !account.owner_business_id) return;
    await fire(db, account.owner_business_id, event, data);
  } catch {
    /* never disturb the caller */
  }
}

/** Helper so payloads always describe money the same way. */
export const amountFields = (cents) => ({
  amount: fromCents(cents),
  amount_cents: cents,
});
