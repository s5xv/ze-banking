// auth.js — Discord login, sessions, and proven Minecraft ownership.
// ===========================================================================
// Two separate things, deliberately not conflated:
//
//   IDENTITY  — who you are on Discord. Gives you a login and an account.
//   OWNERSHIP — proof you control a Minecraft account. Required before any
//               money can leave the bank in your name.
//
// A user can hold a balance with identity alone. Withdrawing needs ownership,
// because a withdrawal sends real money to a Minecraft player, and a
// self-typed username is not evidence of anything.
// ===========================================================================

import * as ledger from "./ledger.js";
import * as treasury from "./treasury.js";

const SESSION_COOKIE = "ze_session";
const OAUTH_COOKIE = "ze_oauth";
const SESSION_SECONDS = 60 * 60 * 24 * 14; // 14 days — shorter than GFC; it's a bank
const enc = new TextEncoder();

// ----- base64url ------------------------------------------------------------
function b64u(buf) {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function unb64u(s) {
  s = String(s).replaceAll("-", "+").replaceAll("_", "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signToken(payload, secret) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64u(sig)}`;
}

export async function verifyToken(token, secret) {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      unb64u(token.slice(dot + 1)),
      enc.encode(body)
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (!payload || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ----- cookies --------------------------------------------------------------
export function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

const setCookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const clearCookie = (name) => `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

const safeNext = (v) => {
  const s = String(v || "/");
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
};

const configured = (env) => !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.TOKEN_SECRET);

// ----- login ----------------------------------------------------------------
export function startLogin(env, request) {
  if (!configured(env)) return new Response("Login is not configured yet.", { status: 503 });

  const url = new URL(request.url);
  const state = crypto.randomUUID().replaceAll("-", "");
  const next = safeNext(url.searchParams.get("next"));

  const authorize = new URL("https://discord.com/api/oauth2/authorize");
  authorize.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("state", state);

  const headers = new Headers({ location: authorize.toString() });
  headers.append("set-cookie", setCookie(OAUTH_COOKIE, `${state}|${next}`, 600));
  return new Response(null, { status: 302, headers });
}

export async function finishLogin(env, db, request) {
  if (!configured(env)) return new Response("Login is not configured yet.", { status: 503 });

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const raw = readCookie(request, OAUTH_COOKIE) || "";
  const bar = raw.indexOf("|");
  const cookieState = bar === -1 ? raw : raw.slice(0, bar);
  const next = safeNext(bar === -1 ? "/" : raw.slice(bar + 1));

  if (!code || !state || !cookieState || !safeEqual(state, cookieState)) {
    return new Response("Login failed: bad or expired state. Try again.", { status: 400 });
  }

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  if (!tokenRes.ok) return new Response("Login failed: Discord rejected the code.", { status: 502 });
  const tok = await tokenRes.json();

  const meRes = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${tok.access_token}` },
  });
  if (!meRes.ok) return new Response("Login failed: couldn't read your Discord profile.", { status: 502 });
  const me = await meRes.json();
  if (!me.id) return new Response("Login failed: no Discord id.", { status: 502 });

  const avatar = me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null;

  await db
    .prepare(
      `INSERT INTO users (discord_id, discord_username, discord_avatar, last_login_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(discord_id) DO UPDATE SET
         discord_username = excluded.discord_username,
         discord_avatar   = excluded.discord_avatar,
         last_login_at    = datetime('now')`
    )
    .bind(me.id, me.global_name || me.username || `user${me.id.slice(-4)}`, avatar)
    .run();

  let user = await db.prepare(`SELECT * FROM users WHERE discord_id = ?`).bind(me.id).first();

  // Bootstrap admins from config.
  const admins = String(env.ADMIN_DISCORD_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (admins.includes(me.id) && user.role !== "admin") {
    await db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).bind(user.id).run();
    user = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(user.id).first();
  }

  // Every user gets a checking account on first login, so there's somewhere
  // for a deposit to land immediately.
  const existing = await ledger.listUserAccounts(db, user.id);
  if (!existing.length) {
    await ledger.openAccount(db, { userId: user.id, kind: "checking", label: "Checking" });
    await ledger.audit(db, { actorId: user.id, action: "account.opened", targetType: "user", targetId: user.id });
  }

  const token = await signToken(
    { uid: user.id, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS },
    env.TOKEN_SECRET
  );

  const headers = new Headers({ location: next });
  headers.append("set-cookie", setCookie(SESSION_COOKIE, token, SESSION_SECONDS));
  headers.append("set-cookie", clearCookie(OAUTH_COOKIE));
  return new Response(null, { status: 302, headers });
}

export function logout() {
  const headers = new Headers({ location: "/" });
  headers.append("set-cookie", clearCookie(SESSION_COOKIE));
  return new Response(null, { status: 302, headers });
}

/** Current user, or null. Role and status are always read fresh from the DB. */
export async function getSession(env, db, request) {
  if (!env.TOKEN_SECRET) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const payload = await verifyToken(token, env.TOKEN_SECRET);
  if (!payload || !payload.uid) return null;
  try {
    const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(payload.uid).first();
    if (!user || user.status !== "active") return null;
    return user;
  } catch {
    return null;
  }
}

export const isStaff = (u) => !!u && (u.role === "staff" || u.role === "admin");
export const isAdmin = (u) => !!u && u.role === "admin";
export const isVerified = (u) => !!u && !!u.mc_verified_at && !!u.mc_uuid;

// ===========================================================================
// Minecraft ownership
// ===========================================================================
const VERIFY_AMOUNT_CENTS = 100; // 1.00 — small enough to be painless
const VERIFY_TTL_MINUTES = 60;

function verifyCode() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return "VERIFY-" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * Begin verification. Resolves the claimed username against the Treasury so we
 * store a real uuid, then issues a one-time code.
 */
export async function startVerification(env, db, user, claimedName) {
  const name = String(claimedName || "").trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    throw new Error("That doesn't look like a Minecraft username.");
  }

  const resolved = await treasury.accountForPlayer(env, { name });
  if (!resolved || !resolved.playerUuid) {
    throw new Error("No Treasury account found for that username. Have you played on the server?");
  }

  // One verified owner per Minecraft account — otherwise two site users could
  // both withdraw "to" the same player.
  const taken = await db
    .prepare(`SELECT id FROM users WHERE mc_uuid = ? AND id <> ? AND mc_verified_at IS NOT NULL`)
    .bind(resolved.playerUuid, user.id)
    .first();
  if (taken) throw new Error("That Minecraft account is already linked to another Z&E Bank user.");

  await db
    .prepare(`UPDATE mc_verifications SET status='expired' WHERE user_id = ? AND status='pending'`)
    .bind(user.id)
    .run();

  const code = verifyCode();
  await db
    .prepare(
      `INSERT INTO mc_verifications (user_id, mc_uuid, mc_username, code, amount_cents, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '+${VERIFY_TTL_MINUTES} minutes'))`
    )
    .bind(user.id, resolved.playerUuid, resolved.playerName || name, code, VERIFY_AMOUNT_CENTS)
    .run();

  return { code, amountCents: VERIFY_AMOUNT_CENTS, mcUsername: resolved.playerName || name };
}

/**
 * Called by deposit ingestion when a payment memo carries a verification code.
 *
 * THE ACTUAL PROOF: `payerUuid` (the Treasury's initiatorUuid) must equal the
 * uuid recorded when verification started. The code alone proves nothing —
 * it's visible to anyone the user shows their screen to. Only the server can
 * say who really sent the money.
 *
 * @returns { verified, userId } — verified=false means the code was real but
 *          the payment came from the wrong account; the caller still credits
 *          the money, it just doesn't confer ownership.
 */
export async function tryCompleteVerification(db, { code, payerUuid }) {
  if (!code || !payerUuid) return { verified: false };

  const v = await db
    .prepare(`SELECT * FROM mc_verifications WHERE code = ? AND status = 'pending'`)
    .bind(code.toUpperCase())
    .first();
  if (!v) return { verified: false };

  if (v.expires_at && new Date(v.expires_at + "Z") < new Date()) {
    await db.prepare(`UPDATE mc_verifications SET status='expired' WHERE id = ?`).bind(v.id).run();
    return { verified: false, reason: "expired" };
  }

  if (v.mc_uuid !== payerUuid) {
    // Someone used a code that wasn't theirs. Reject it and leave a trail.
    await db.prepare(`UPDATE mc_verifications SET status='rejected' WHERE id = ?`).bind(v.id).run();
    await ledger.audit(db, {
      action: "verification.wrong_payer",
      targetType: "verification",
      targetId: v.id,
      detail: `expected ${v.mc_uuid}, got ${payerUuid}`,
    });
    return { verified: false, reason: "wrong-payer" };
  }

  await db.batch([
    db.prepare(`UPDATE mc_verifications SET status='verified', verified_at=datetime('now') WHERE id = ?`).bind(v.id),
    db
      .prepare(`UPDATE users SET mc_uuid = ?, mc_username = ?, mc_verified_at = datetime('now') WHERE id = ?`)
      .bind(v.mc_uuid, v.mc_username, v.user_id),
  ]);

  await ledger.audit(db, {
    actorId: v.user_id,
    action: "verification.completed",
    targetType: "user",
    targetId: v.user_id,
    detail: v.mc_username,
  });

  return { verified: true, userId: v.user_id };
}

export async function pendingVerification(db, userId) {
  return await db
    .prepare(
      `SELECT * FROM mc_verifications
       WHERE user_id = ? AND status = 'pending' AND expires_at > datetime('now')
       ORDER BY id DESC LIMIT 1`
    )
    .bind(userId)
    .first();
}
