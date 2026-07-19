// index.js - Z&E Bank worker entry point.
// ===========================================================================
// STATUS: ledger core, deposit ingestion and withdrawals are built. The
// customer-facing UI and Discord auth are next, so most routes below are
// placeholders. Nothing here can move money without the Treasury secrets
// configured, so deploying this early is safe.
// ===========================================================================

import * as ledger from "./ledger.js";
import * as treasury from "./treasury.js";
import * as deposits from "./deposits.js";
import * as withdrawals from "./withdrawals.js";
import * as auth from "./auth.js";
import * as customer from "./customer.js";
import * as admin from "./admin.js";
import * as interest from "./interest.js";
import { formatCents } from "./money.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Z&amp;E Bank</title>
<style>
  :root{--bg:#0b0d12;--panel:#141821;--line:#242a36;--text:#e9edf5;--muted:#8f9bb3;--accent:#3b82f6;--good:#34d399;--bad:#f87171}
  @media (prefers-color-scheme: light){
    :root{--bg:#f6f8fc;--panel:#fff;--line:#e2e8f0;--text:#0f172a;--muted:#64748b}
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font-family:Inter,system-ui,Segoe UI,Roboto,sans-serif;line-height:1.55}
  .wrap{max-width:880px;margin:0 auto;padding:48px 20px}
  h1{font-size:30px;margin:0 0 6px}
  .muted{color:var(--muted)}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:18px}
  .row{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid var(--line)}
  .row:last-child{border-bottom:0}
  code{background:var(--bg);border:1px solid var(--line);padding:2px 6px;border-radius:5px;font-size:13px}
  .ok{color:var(--good)}.bad{color:var(--bad)}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Health / status - proves config is right before any money is at risk.
// ---------------------------------------------------------------------------
async function statusPage(env, showSolvency = false) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add("D1 binding", !!env.DB, env.DB ? "bound" : "missing");
  add("DC_API_TOKEN", !!env.DC_API_TOKEN, env.DC_API_TOKEN ? "set" : "not set");
  add("POOL_ACCOUNT_ID", !!env.POOL_ACCOUNT_ID, env.POOL_ACCOUNT_ID ? "set" : "not set");
  add("TOKEN_SECRET", !!env.TOKEN_SECRET, env.TOKEN_SECRET ? "set" : "not set");

  let schemaOk = false;
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN
       ('users','accounts','entries','postings','deposits','withdrawals','interest_runs')`
    ).first();
    schemaOk = r && r.n === 7;
    add("Schema", schemaOk, schemaOk ? "all core tables present" : `${r ? r.n : 0}/7 tables - run schema.sql`);
  } catch (e) {
    add("Schema", false, e.message);
  }

  let solvencyBlock = `<p class="muted">Sign in as staff to see live figures.</p>`;
  if (showSolvency && env.DC_API_TOKEN && env.POOL_ACCOUNT_ID && schemaOk) {
    try {
      const poolCents = await treasury.poolBalanceCents(env);
      const s = await ledger.solvency(env.DB, poolCents);
      solvencyBlock = `
        <div class="row"><span>Treasury pool (real)</span><b>${formatCents(s.treasuryCents)}</b></div>
        <div class="row"><span>Owed to customers</span><b>${formatCents(s.liabilities)}</b></div>
        <div class="row"><span>Bank equity</span><b class="${s.equity < 0 ? "bad" : "ok"}">${formatCents(s.equity)}</b></div>
        <div class="row"><span>Reserve floor (${(s.reserveRatioBps / 100).toFixed(0)}%)</span><b>${formatCents(s.reserveFloor)}</b></div>
        <div class="row"><span>Safe to withdraw</span><b>${formatCents(s.safeToWithdraw)}</b></div>
        ${s.underReserved ? `<p class="bad"><b>UNDER-RESERVED</b> - the bank cannot currently cover all deposits.</p>` : ""}`;
    } catch (e) {
      solvencyBlock = `<p class="bad">Treasury error: ${esc(e.message)}</p>`;
    }
  }

  const rows = checks
    .map((c) => `<div class="row"><span>${esc(c.name)}</span><b class="${c.ok ? "ok" : "bad"}">${esc(c.detail)}</b></div>`)
    .join("");

  return html(
    page(
      "Status",
      `<h1>Z&amp;E Bank</h1>
       <p class="muted">Build in progress - ledger core, deposits and withdrawals are live.
       Customer UI and Discord login are next.</p>
       <div class="card"><h3 style="margin-top:0">Configuration</h3>${rows}</div>
       <div class="card"><h3 style="margin-top:0">Solvency</h3>${solvencyBlock}</div>
       <div class="card"><h3 style="margin-top:0">Setup</h3>
         <p class="muted">Create the database, then apply the schema:</p>
         <p><code>npx wrangler d1 create ze-bank</code></p>
         <p><code>npx wrangler d1 execute ze-bank --remote --file=schema.sql</code></p>
       </div>`
    )
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // ----- auth (no session required) -----
      if (path === "/auth/login") return auth.startLogin(env, request);
      if (path === "/auth/callback") return await auth.finishLogin(env, env.DB, request);
      if (path === "/auth/logout") return auth.logout();

      // ----- customer app -----
      if (path === "/app" || path.startsWith("/app/")) {
        const user = await auth.getSession(env, env.DB, request);
        if (!user) {
          return Response.redirect(`${url.origin}/auth/login?next=${encodeURIComponent(path)}`, 302);
        }

        if (request.method === "POST") {
          if (path === "/app/withdraw") return await customer.doWithdraw(env, env.DB, user, request);
          if (path === "/app/transfer") return await customer.doTransfer(env, env.DB, user, request);
          if (path === "/app/verify") return await customer.doVerify(env, env.DB, user, request);
          if (path === "/app/accounts/open") return await customer.doOpenAccount(env, env.DB, user, request);
          return new Response("Method not allowed", { status: 405 });
        }

        if (path === "/app") return await customer.pageHome(env, env.DB, user);
        if (path === "/app/deposit") return await customer.pageDeposit(env, env.DB, user);
        if (path === "/app/withdraw") return await customer.pageWithdraw(env, env.DB, user);
        if (path === "/app/transfer") return await customer.pageTransfer(env, env.DB, user);
        if (path === "/app/verify") return await customer.pageVerify(env, env.DB, user);

        const m = path.match(/^\/app\/account\/(\d+)$/);
        if (m) return await customer.pageAccount(env, env.DB, user, parseInt(m[1], 10));

        return html(page("Not found", `<h1>404</h1>`), 404);
      }

      // ----- admin (staff + admin roles) -----
      if (path === "/admin" || path.startsWith("/admin/")) {
        const user = await auth.getSession(env, env.DB, request);
        if (!user) {
          return Response.redirect(`${url.origin}/auth/login?next=${encodeURIComponent(path)}`, 302);
        }
        if (!auth.isStaff(user)) {
          return html(page("Admin", `<h1>Not authorised</h1>
            <p class="muted">Your account doesn't have staff access.</p>`), 403);
        }
        const db = env.DB;

        if (request.method === "POST") {
          if (path === "/admin/withdrawals") return await admin.doWithdrawalAction(env, db, user, request);
          if (path === "/admin/deposits") return await admin.doAssignDeposit(env, db, user, request);
          if (path === "/admin/adjust") return await admin.doAdjust(env, db, user, request);
          if (path === "/admin/settings") return await admin.doSettings(env, db, user, request);
          const cm = path.match(/^\/admin\/customer\/(\d+)$/);
          if (cm) return await admin.doCustomerAction(env, db, user, parseInt(cm[1], 10), request);
          return new Response("Method not allowed", { status: 405 });
        }

        if (path === "/admin") return await admin.pageDashboard(env, db, user);
        if (path === "/admin/withdrawals") return await admin.pageWithdrawals(env, db, user);
        if (path === "/admin/deposits") return await admin.pageDeposits(env, db, user);
        if (path === "/admin/customers")
          return await admin.pageCustomers(env, db, user, url.searchParams.get("q") || "");
        if (path === "/admin/adjust") return await admin.pageAdjust(env, db, user);
        if (path === "/admin/reconciliation") return await admin.pageReconciliation(env, db, user);
        if (path === "/admin/settings") return await admin.pageSettings(env, db, user);
        if (path === "/admin/audit") return await admin.pageAudit(env, db, user);

        const cm = path.match(/^\/admin\/customer\/(\d+)$/);
        if (cm) return await admin.pageCustomer(env, db, user, parseInt(cm[1], 10));

        return html(page("Not found", `<h1>404</h1>`), 404);
      }

      // Public homepage. Session is optional - it only changes the call to action.
      if (path === "/") {
        const user = await auth.getSession(env, env.DB, request).catch(() => null);
        return await customer.pageLanding(env, env.DB, user);
      }

      // Setup/diagnostics. Config state is fine to show while nothing is
      // configured, but solvency figures are staff-only.
      if (path === "/status") {
        const user = await auth.getSession(env, env.DB, request).catch(() => null);
        return await statusPage(env, auth.isStaff(user));
      }

      if (path === "/health") return json({ ok: true, service: "ze-bank" });

      // One-time helper for finding POOL_ACCOUNT_ID. Lists the firm's accounts
      // so you can pick the one that will hold customer funds.
      // Gated on TOKEN_SECRET because it exposes firm balances.
      if (path === "/setup/treasury") {
        const key = url.searchParams.get("key") || "";
        if (!env.TOKEN_SECRET || key !== env.TOKEN_SECRET) {
          return json({ ok: false, error: "pass ?key=<TOKEN_SECRET>" }, 401);
        }
        if (!env.DC_API_TOKEN) return json({ ok: false, error: "DC_API_TOKEN not set yet" }, 400);

        const me = await treasury.whoami(env);
        let accounts = [];
        try {
          accounts = await treasuryFirmAccounts(env);
        } catch (e) {
          return json({ ok: false, me, error: `could not list firm accounts: ${e.message}` }, 502);
        }
        return json({
          ok: true,
          note: "Set POOL_ACCOUNT_ID to the accountId that will hold customer deposits.",
          keyType: me.keyType,
          firmId: me.firmId,
          personalAccountId: me.accountId,
          accounts,
        });
      }

      // Treasury deposit webhook. Verifies a signature, then pulls the
      // authoritative feed - the payload itself is never trusted to create
      // money. See deposits.js.
      if (path === "/webhooks/treasury" && request.method === "POST") {
        const r = await deposits.handleWebhook(env, env.DB, request);
        return json(r, r.status || 200);
      }

      return html(page("Not found", `<h1>404</h1><p class="muted">Nothing here.</p>`), 404);
    } catch (err) {
      return html(page("Error", `<h1>Something broke</h1><p class="bad">${esc(err.message)}</p>`), 500);
    }
  },

  // -------------------------------------------------------------------------
  // Scheduled work.
  //   */5 * * * *  - ingest deposits, retry stuck withdrawals
  //   0   * * * *  - reconcile the books
  // Both are idempotent, so overlapping or repeated runs are harmless.
  // -------------------------------------------------------------------------
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        if (!env.DC_API_TOKEN || !env.POOL_ACCOUNT_ID) return;

        try {
          const ingested = await deposits.ingestFeed(env, env.DB);
          if (ingested.credited) console.log("deposits credited:", JSON.stringify(ingested));
        } catch (err) {
          console.error("deposit ingest failed:", err.message);
        }

        try {
          const stuck = await withdrawals.reviewStuck(env, env.DB);
          if (stuck.resolved || stuck.reversed || stuck.stillUnknown) {
            console.log("withdrawal review:", JSON.stringify(stuck));
          }
        } catch (err) {
          console.error("withdrawal review failed:", err.message);
        }

        // Hourly: prove the books balance, then pay any interest due.
        if (event.cron === "0 * * * *") {
          try {
            await reconcile(env, env.DB);
          } catch (err) {
            console.error("reconcile failed:", err.message);
          }

          // Runs every hour but only acts in the first three days of the
          // month, and every payment is guarded by a deterministic
          // idempotency key, so repeated runs cannot pay twice. The window
          // means a bank that was down on the 1st still pays its customers.
          try {
            const res = await interest.maybeRunMonthly(env, env.DB);
            if (res && res.paid) console.log("interest run:", JSON.stringify(res));
          } catch (err) {
            console.error("interest run failed:", err.message);
          }
        }
      })()
    );
  },
};

/** Firm accounts, for the setup helper above. */
async function treasuryFirmAccounts(env) {
  const res = await fetch("https://api.democracycraft.net/economy/api/v1/firms/me/accounts", {
    headers: { Authorization: `Bearer ${env.DC_API_TOKEN}`, accept: "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

/**
 * Reconciliation: does the real Treasury balance match what our books say it
 * should be?
 *
 * Every real movement posts to the pool account, and the sign convention means
 * -pool.balance_cents is the net real money that has flowed through us. If
 * that doesn't equal the Treasury balance, money is missing or invented, and
 * withdrawals stop until a human looks.
 */
async function reconcile(env, db) {
  const treasuryCents = await treasury.poolBalanceCents(env);
  const pool = await ledger.getAccount(db, ledger.POOL_ACCOUNT_ID);
  const expected = -(pool ? pool.balance_cents : 0);
  const drift = treasuryCents - expected;

  const [unbalanced, mismatches] = await Promise.all([
    ledger.findUnbalancedEntries(db),
    ledger.findBalanceMismatches(db),
  ]);

  const liab = await db
    .prepare(
      `SELECT COALESCE(SUM(balance_cents),0) AS total FROM accounts WHERE kind IN ('checking','savings')`
    )
    .first();

  await db
    .prepare(
      `INSERT INTO reconciliations
         (treasury_cents, ledger_cents, liabilities_cents, drift_cents,
          balance_mismatches, unbalanced_entries)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(treasuryCents, expected, liab.total, drift, mismatches.length, unbalanced.length)
    .run();

  if (drift !== 0 || unbalanced.length || mismatches.length) {
    await ledger.setSetting(db, "withdrawals_paused", "1");
    await ledger.audit(db, {
      action: "reconcile.drift",
      detail: `drift=${drift} unbalanced=${unbalanced.length} mismatches=${mismatches.length} - withdrawals paused`,
    });
    console.error("RECONCILE DRIFT", { drift, unbalanced: unbalanced.length, mismatches: mismatches.length });
  }

  return { treasuryCents, expected, drift };
}
