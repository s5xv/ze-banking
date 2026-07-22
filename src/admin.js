// admin.js - staff dashboard.
// ===========================================================================
// Every action here can move real money, so all of them are POSTs, all of them
// are audit-logged with the actor, and none of them are one-click. Manual
// adjustments require a written reason - an unexplained balance change in a
// bank is indistinguishable from theft after the fact.
//
// The solvency panel is READ-ONLY. It reports what could safely be withdrawn;
// it does not have a button that does it. Taking money out goes through the
// normal withdrawal path, from an account, with a record.
// ===========================================================================

import * as ledger from "./ledger.js";
import * as treasury from "./treasury.js";
import * as deposits from "./deposits.js";
import * as withdrawals from "./withdrawals.js";
import * as biz from "./business.js";
import { parseUserAmount, formatCents } from "./money.js";
import { esc, html, layout, money, signedMoney, shortDate, notice, redirect, payCommand } from "./views.js";

const money0 = (c) => formatCents(c);

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------
export async function pageDashboard(env, db, user, message = "") {
  let solvencyBlock;
  let poolCents = null;

  try {
    poolCents = await treasury.poolBalanceCents(env);
    const s = await ledger.solvency(db, poolCents);
    const equityClass = s.equity < 0 ? "bad" : "good";

    solvencyBlock = `
      <div class="cards c3">
        <div class="card">
          <div class="muted small">Held at Treasury</div>
          <div class="balance">${money0(s.treasuryCents)}</div>
          <div class="muted small">real money the bank has</div>
        </div>
        <div class="card">
          <div class="muted small">Owed to customers</div>
          <div class="balance">${money0(s.liabilities)}</div>
          <div class="muted small">sum of every balance</div>
        </div>
        <div class="card">
          <div class="muted small">Bank equity</div>
          <div class="balance ${equityClass}">${money0(s.equity)}</div>
          <div class="muted small">assets minus what's owed</div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="acct-row">
          <div><b>Reserve requirement</b>
            <div class="muted small">${(s.reserveRatioBps / 100).toFixed(0)}% of customer deposits must stay held</div>
          </div>
          <div style="text-align:right;font-weight:700">${money0(s.reserveFloor)}</div>
        </div>
        <div class="acct-row">
          <div><b>Safe to withdraw</b>
            <div class="muted small">bank's own money, above the reserve floor</div>
          </div>
          <div style="text-align:right;font-weight:700">${money0(s.safeToWithdraw)}</div>
        </div>
      </div>
      ${
        s.underReserved
          ? notice(
              `<b>UNDER-RESERVED.</b> The bank is holding less than it owes customers.
               Withdrawals may fail. Do not take any more money out.`,
              "bad"
            )
          : ""
      }
      ${
        s.equity < 0
          ? notice(
              `<b>Negative equity.</b> The bank owes customers more than it holds - usually
               interest paid out without matching income. This does not fix itself.`,
              "warn"
            )
          : ""
      }`;
  } catch (err) {
    // The DemocracyCraft API is down or unreachable. Rather than showing
    // nothing, fall back to the last reconciliation, clearly labelled with
    // when it was taken. Stale figures are useful; unlabelled stale figures
    // are dangerous, so the timestamp is not optional.
    const last = await db
      .prepare(`SELECT * FROM reconciliations ORDER BY id DESC LIMIT 1`)
      .first();

    const liabRow = await db
      .prepare(
        `SELECT COALESCE(SUM(balance_cents),0) AS total FROM accounts
          WHERE kind IN ('checking','savings')`
      )
      .first();

    solvencyBlock =
      notice(
        `<b>The DemocracyCraft economy API is not responding</b> (${esc(err.message)}).
         This is their outage, not the bank's. Deposits will catch up automatically and
         withdrawals are refused rather than half completed, so nothing is lost.`,
        "bad"
      ) +
      (last
        ? `<div class="cards c3" style="margin-top:16px">
             <div class="card">
               <div class="muted small">Held at Treasury</div>
               <div class="balance">${money0(last.treasury_cents)}</div>
               <div class="muted small">as of ${shortDate(last.created_at)}</div>
             </div>
             <div class="card">
               <div class="muted small">Owed to customers</div>
               <div class="balance">${money0(liabRow ? liabRow.total : 0)}</div>
               <div class="muted small">live, from our own books</div>
             </div>
             <div class="card">
               <div class="muted small">Equity at last check</div>
               <div class="balance ${last.treasury_cents - last.liabilities_cents < 0 ? "bad" : "good"}">
                 ${money0(last.treasury_cents - last.liabilities_cents)}</div>
               <div class="muted small">stale, do not act on this</div>
             </div>
           </div>`
        : `<p class="muted">No previous reconciliation to fall back on.</p>`);
  }

  const [needReview, unmatched, lastRecon, paused] = await Promise.all([
    withdrawals.listNeedingReview(db),
    deposits.listUnmatched(db),
    db.prepare(`SELECT * FROM reconciliations ORDER BY id DESC LIMIT 1`).first(),
    ledger.getSetting(db, "withdrawals_paused", "0"),
  ]);

  const driftBlock =
    lastRecon && lastRecon.drift_cents !== 0
      ? notice(
          `<b>Books don't balance.</b> Drift of ${money0(lastRecon.drift_cents)} at
           ${shortDate(lastRecon.created_at)}. Withdrawals were paused automatically.
           <a href="/admin/reconciliation">Investigate →</a>`,
          "bad"
        )
      : "";

  const pausedBlock =
    paused === "1"
      ? `<div class="notice warn">
          <b>Withdrawals are paused.</b> Customers can't take money out.
          <form method="POST" action="/admin/settings" style="margin-top:10px">
            <input type="hidden" name="key" value="withdrawals_paused">
            <input type="hidden" name="value" value="0">
            <button class="btn sm" type="submit">Resume withdrawals</button>
          </form>
        </div>`
      : "";

  // Bank funding. The owner covers the interest shortfall, so both numbers
  // need to be visible: how much has been put in, and how much has been paid
  // out as interest. If the second is outrunning the first, the bank is
  // running on a promise rather than on capital.
  const equity = await ledger.getAccount(db, ledger.EQUITY_ACCOUNT_ID);
  const injected = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM deposits
       WHERE account_id = ? AND status = 'credited'`
    )
    .bind(ledger.EQUITY_ACCOUNT_ID)
    .first();
  const interestPaid = await db
    .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM interest_runs`)
    .first();

  const fundingBlock = `
    <div class="card" style="margin-top:16px">
      <h3>Bank funding</h3>
      <div class="acct-row">
        <div><b>Capital put in</b>
          <div class="muted small">real money paid into the bank by the owner</div></div>
        <div style="text-align:right;font-weight:700">${money0(injected ? injected.total : 0)}</div>
      </div>
      <div class="acct-row">
        <div><b>Interest paid out</b>
          <div class="muted small">total ever credited to savings accounts</div></div>
        <div style="text-align:right;font-weight:700">${money0(interestPaid ? interestPaid.total : 0)}</div>
      </div>
      ${
        equity && equity.deposit_code
          ? `<p class="muted small" style="margin-top:14px;margin-bottom:6px">
               To put money into the bank, pay this code in game. It credits bank
               capital, not a customer account.</p>
             <div class="code">${esc(payCommand(env, "<amount>", equity.deposit_code))}</div>`
          : `<p class="muted small">Run migration 002 to generate the funding code.</p>`
      }
    </div>`;

  const queues = `
    <div class="cards c2" style="margin-top:16px">
      <div class="card">
        <h3>Withdrawals needing attention</h3>
        <div class="balance" style="font-size:26px">${needReview.length}</div>
        <a class="small muted" href="/admin/withdrawals">Review →</a>
      </div>
      <div class="card">
        <h3>Unmatched deposits</h3>
        <div class="balance" style="font-size:26px">${unmatched.length}</div>
        <a class="small muted" href="/admin/deposits">Assign →</a>
      </div>
    </div>`;

  const body = `<section>
    <h1>Admin</h1>
    <p class="muted">Signed in as ${esc(user.discord_username)} · ${esc(user.role)}</p>
    ${message}${pausedBlock}${driftBlock}
    ${solvencyBlock}
    ${fundingBlock}
    ${queues}
    <div class="card" style="margin-top:16px">
      <h3>Tools</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
        <a class="btn ghost sm" href="/admin/approvals">Approvals</a>
        <a class="btn ghost sm" href="/admin/lending">Lending</a>
        <a class="btn ghost sm" href="/admin/customers">Customers</a>
        <a class="btn ghost sm" href="/admin/businesses">Companies</a>
        <a class="btn ghost sm" href="/admin/adjust">Manual entry</a>
        <a class="btn ghost sm" href="/admin/reconciliation">Reconciliation</a>
        <a class="btn ghost sm" href="/admin/webhooks">Notifications</a>
        <a class="btn ghost sm" href="/admin/settings">Settings</a>
        <a class="btn ghost sm" href="/admin/audit">Audit log</a>
      </div>
    </div>
  </section>`;
  return html(layout("Admin", body, { user, active: "admin" }));
}

// ---------------------------------------------------------------------------
// withdrawal queue
// ---------------------------------------------------------------------------
export async function pageWithdrawals(env, db, user, message = "") {
  const rows = await withdrawals.listNeedingReview(db);

  const table = rows.length
    ? rows
        .map(
          (w) => `<tr>
            <td>#${w.id}<div class="muted small">${shortDate(w.created_at)}</div></td>
            <td>${esc(w.mc_username || w.to_player_name || "-")}
              <div class="muted small">${esc(w.discord_username || "")}</div></td>
            <td class="num">${money0(w.amount_cents)}</td>
            <td><span class="pill warn">${esc(w.status.replace("_", " "))}</span>
              <div class="muted small">${esc((w.failure_reason || "").slice(0, 70))}</div>
              <div class="muted small">${w.attempts} attempt(s)</div></td>
            <td style="text-align:right;white-space:nowrap">
              <form method="POST" action="/admin/withdrawals" style="display:inline">
                <input type="hidden" name="id" value="${w.id}">
                <input type="hidden" name="action" value="retry">
                <button class="btn sm" type="submit">Re-check</button>
              </form>
            </td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="muted">Nothing waiting. Good.</td></tr>`;

  const body = `<section>
    <a class="muted small" href="/admin">← Admin</a>
    <h1 style="margin-top:10px">Withdrawals</h1>
    ${message}
    ${notice(
      `<b>Re-check</b> re-sends the original request with the same idempotency key.
       The Treasury will return the original result rather than paying again, so this is
       always safe. It resolves to <i>sent</i> or reverses the money back to the customer.
       Never resolve one of these by paying the player manually - that's how someone gets
       paid twice.`
    )}
    <div class="card" style="margin-top:16px">
      <table><thead><tr><th>Withdrawal</th><th>To</th><th style="text-align:right">Amount</th>
      <th>Status</th><th></th></tr></thead><tbody>${table}</tbody></table>
    </div>
  </section>`;
  return html(layout("Withdrawals", body, { user, active: "admin" }));
}

export async function doWithdrawalAction(env, db, user, request) {
  const form = await request.formData();
  const id = parseInt(form.get("id"), 10);
  if (!Number.isFinite(id)) return redirect("/admin/withdrawals");

  const res = await withdrawals.attemptPayout(env, db, id);
  await ledger.audit(db, {
    actorId: user.id,
    action: "withdrawal.recheck",
    targetType: "withdrawal",
    targetId: id,
    detail: res.status,
  });

  const msg =
    res.status === "sent"
      ? notice(`Withdrawal #${id} confirmed as <b>sent</b>. The customer was paid once.`, "good")
      : res.status === "failed"
      ? notice(`Withdrawal #${id} did not go through. The money has been returned.`, "good")
      : notice(`Withdrawal #${id} is still unconfirmed. Leave it - do not pay manually.`, "warn");

  return await pageWithdrawals(env, db, user, msg);
}

// ---------------------------------------------------------------------------
// unmatched deposits
// ---------------------------------------------------------------------------
export async function pageDeposits(env, db, user, message = "") {
  const rows = await deposits.listUnmatched(db);

  const table = rows.length
    ? rows
        .map(
          (d) => `<tr>
            <td>${shortDate(d.created_at)}</td>
            <td class="num">${money0(d.amount_cents)}</td>
            <td class="small">${esc(d.memo || "-")}
              <div class="muted small">${esc(d.payer_uuid || "unknown payer")}</div></td>
            <td>
              <form method="POST" action="/admin/deposits" style="display:flex;gap:8px">
                <input type="hidden" name="deposit_id" value="${d.id}">
                <input name="account_id" placeholder="Account #" style="width:120px" required>
                <button class="btn sm" type="submit">Assign</button>
              </form>
            </td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="muted">Nothing unmatched.</td></tr>`;

  const body = `<section>
    <a class="muted small" href="/admin">← Admin</a>
    <h1 style="margin-top:10px">Unmatched deposits</h1>
    ${message}
    ${notice(
      `Real money that arrived without a usable deposit code, held in suspense.
       Find the account number on the customer's page, then assign it here.
       Assigning moves it out of suspense - it does not create money.`
    )}

    <div class="card" style="margin-top:16px">
      <h3>Check for deposits now</h3>
      <p class="muted small" style="margin-top:0">Deposits are picked up automatically every
      5 minutes. This runs that check immediately, which is useful when someone has just paid
      and is waiting, or when testing verification.</p>
      <form method="POST" action="/admin/deposits">
        <input type="hidden" name="action" value="ingest">
        <button class="btn" type="submit">Check the Treasury now</button>
      </form>
    </div>
    <div class="card" style="margin-top:16px">
      <table><thead><tr><th>When</th><th style="text-align:right">Amount</th>
      <th>Memo / payer</th><th>Assign to</th></tr></thead><tbody>${table}</tbody></table>
    </div>
  </section>`;
  return html(layout("Deposits", body, { user, active: "admin" }));
}

export async function doAssignDeposit(env, db, user, request) {
  const form = await request.formData();

  // Manual ingestion. Deposits normally arrive on a 5 minute cron, which makes
  // testing painful and makes a customer who just paid think nothing happened.
  if (String(form.get("action")) === "ingest") {
    try {
      const res = await deposits.ingestFeed(env, db);
      await ledger.audit(db, {
        actorId: user.id,
        action: "deposit.manual_ingest",
        detail: JSON.stringify(res),
      });
      return await pageDeposits(
        env, db, user,
        notice(
          `Checked the Treasury. Credited ${res.credited}, already seen ${res.skipped},
           unmatched ${res.unmatched}. Cursor now ${res.cursor}.`,
          "good"
        )
      );
    } catch (err) {
      return await pageDeposits(env, db, user, notice(`Could not read the Treasury: ${esc(err.message)}`, "bad"));
    }
  }

  const depositId = parseInt(form.get("deposit_id"), 10);
  const accountId = parseInt(form.get("account_id"), 10);

  try {
    await deposits.assignUnmatched(db, depositId, accountId, user.id);
    return await pageDeposits(env, db, user, notice(`Deposit #${depositId} assigned.`, "good"));
  } catch (err) {
    return await pageDeposits(env, db, user, notice(esc(err.message), "bad"));
  }
}

// ---------------------------------------------------------------------------
// customers
// ---------------------------------------------------------------------------
export async function pageCustomers(env, db, user, query = "", message = "") {
  const base = `SELECT u.*,
      (SELECT COALESCE(SUM(balance_cents),0) FROM accounts a WHERE a.owner_user_id = u.id) AS total_cents
    FROM users u`;

  const stmt = query
    ? db
        .prepare(
          `${base} WHERE LOWER(u.discord_username) LIKE ?1 OR LOWER(u.mc_username) LIKE ?1
           ORDER BY u.id DESC LIMIT 100`
        )
        .bind(`%${query.toLowerCase()}%`)
    : db.prepare(`${base} ORDER BY u.id DESC LIMIT 100`);

  const { results } = await stmt.all();

  const rows = results
    .map(
      (u) => `<tr>
        <td>${esc(u.discord_username || "-")}
          <div class="muted small">${esc(u.discord_id)}</div></td>
        <td>${esc(u.mc_username || "-")}
          ${u.mc_verified_at ? `<span class="pill good">verified</span>` : `<span class="pill">unverified</span>`}</td>
        <td class="num">${money0(u.total_cents)}</td>
        <td><span class="pill">${esc(u.role)}</span></td>
        <td style="text-align:right"><a class="btn ghost sm" href="/admin/customer/${u.id}">Open</a></td>
      </tr>`
    )
    .join("");

  const body = `<section>
    <a class="muted small" href="/admin">← Admin</a>
    <h1 style="margin-top:10px">Customers</h1>
    ${message}
    <form method="GET" action="/admin/customers" style="display:flex;gap:10px;margin:16px 0">
      <input name="q" placeholder="Search Discord or Minecraft name" value="${esc(query)}">
      <button class="btn ghost" type="submit">Search</button>
    </form>
    <div class="card">
      <table><thead><tr><th>Discord</th><th>Minecraft</th><th style="text-align:right">Balance</th>
      <th>Role</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="muted">No customers.</td></tr>`}</tbody></table>
    </div>
  </section>`;
  return html(layout("Customers", body, { user, active: "admin" }));
}

export async function pageCustomer(env, db, user, customerId, message = "") {
  const c = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(customerId).first();
  if (!c) return html(layout("Not found", `<section><h1>No such customer</h1></section>`, { user }), 404);

  // Every account the person touches, including company accounts they own, so
  // staff see the full picture from one page.
  const { results: accounts } = await db
    .prepare(
      `SELECT a.*, b.display_name AS business_name
         FROM accounts a
         LEFT JOIN businesses b ON b.id = a.owner_business_id
        WHERE a.owner_user_id = ? AND a.status <> 'closed'
        ORDER BY a.id`
    )
    .bind(c.id)
    .all();

  const accountRows = accounts
    .map(
      (a) => `<div class="acct-row">
        <div><b>${esc(a.label || a.kind)}</b> <span class="muted small">#${a.id}</span>
          <div class="muted small">${esc(a.kind)} · ${esc(a.status)}
            ${a.business_name ? `· company: ${esc(a.business_name)}` : ""}
            ${a.interest_bps ? `· ${(a.interest_bps / 100).toFixed(2)}% fixed` : ""}
            ${a.deposit_code ? `· code <code>${esc(a.deposit_code)}</code>` : ""}</div></div>
        <div style="text-align:right">
          <div style="font-weight:700">${money0(a.balance_cents)}</div>
          <div style="display:flex;gap:6px;margin-top:6px;justify-content:flex-end;flex-wrap:wrap">
            <a class="btn ghost sm" href="/admin/adjust?account=${a.id}">Adjust</a>
            <form method="POST" action="/admin/customer/${c.id}" style="display:inline">
              <input type="hidden" name="action" value="${a.status === "frozen" ? "unfreeze" : "freeze"}">
              <input type="hidden" name="account_id" value="${a.id}">
              <button class="btn ghost sm" type="submit">${a.status === "frozen" ? "Unfreeze" : "Freeze"}</button>
            </form>
            ${
              a.balance_cents === 0 && !a.owner_business_id
                ? `<form method="POST" action="/admin/customer/${c.id}" style="display:inline">
                     <input type="hidden" name="action" value="close_account">
                     <input type="hidden" name="account_id" value="${a.id}">
                     <button class="btn ghost sm" type="submit">Close</button>
                   </form>`
                : ""
            }
          </div>
        </div>
      </div>`
    )
    .join("");

  const hasSavings = accounts.some((a) => a.kind === "savings" && !a.owner_business_id);

  const accountTools = `
    <div class="card" style="margin-top:16px">
      <h3>Open an account for them</h3>
      <form method="POST" action="/admin/customer/${c.id}" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <input type="hidden" name="action" value="open_account">
        <select name="kind" style="width:auto">
          <option value="checking">Checking</option>
          <option value="savings"${hasSavings ? " disabled" : ""}>Savings</option>
        </select>
        <button class="btn ghost sm" type="submit">Open</button>
      </form>
      <p class="muted small" style="margin-bottom:0">Accounts can only be closed at a zero
      balance, so money can never be stranded in a closed account.</p>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Fix a rate</h3>
      <p class="muted small" style="margin-top:0">Overrides the global savings rate for one
      account. Leave at 0 to follow the global rate.</p>
      <form method="POST" action="/admin/customer/${c.id}" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <input type="hidden" name="action" value="set_rate">
        <select name="account_id" style="width:auto">
          ${accounts
            .filter((a) => a.kind === "savings")
            .map((a) => `<option value="${a.id}">#${a.id} ${esc(a.label || "")}</option>`)
            .join("") || `<option value="">no savings accounts</option>`}
        </select>
        <input name="bps" placeholder="basis points, e.g. 300" style="width:200px">
        <button class="btn ghost sm" type="submit">Set</button>
      </form>
    </div>`;

  const body = `<section>
    <a class="muted small" href="/admin/customers">← Customers</a>
    <h1 style="margin-top:10px">${esc(c.discord_username || "Customer")}</h1>
    <p class="muted">${esc(c.mc_username || "no Minecraft account")}
      ${c.mc_verified_at ? `<span class="pill good">verified</span>` : `<span class="pill">unverified</span>`}
      · role ${esc(c.role)}</p>
    ${message}
    <div class="card" style="margin-top:16px"><h3>Accounts</h3>${accountRows || `<p class="muted">None.</p>`}</div>
    ${accountTools}
    ${
      user.role === "admin"
        ? `<div class="card" style="margin-top:16px">
            <h3>Role</h3>
            <form method="POST" action="/admin/customer/${c.id}" style="display:flex;gap:10px">
              <input type="hidden" name="action" value="role">
              <select name="role">
                ${["customer", "staff", "admin"]
                  .map((r) => `<option value="${r}"${c.role === r ? " selected" : ""}>${r}</option>`)
                  .join("")}
              </select>
              <button class="btn ghost" type="submit" ${c.id === user.id ? "disabled" : ""}>Update</button>
            </form>
            ${c.id === user.id ? `<p class="muted small">You cannot change your own role.</p>` : ""}
          </div>
          <div class="card" style="margin-top:16px">
            <h3>Access</h3>
            <p class="muted small" style="margin-top:0">Suspending blocks login entirely. Their
            money is untouched and their balances keep earning interest.</p>
            <form method="POST" action="/admin/customer/${c.id}">
              <input type="hidden" name="action" value="${c.status === "suspended" ? "unsuspend" : "suspend"}">
              <button class="btn ghost sm" type="submit" ${c.id === user.id ? "disabled" : ""}>
                ${c.status === "suspended" ? "Restore access" : "Suspend customer"}</button>
            </form>
          </div>`
        : ""
    }
  </section>`;
  return html(layout("Customer", body, { user, active: "admin" }));
}

export async function doCustomerAction(env, db, user, customerId, request) {
  const form = await request.formData();
  const action = String(form.get("action") || "");

  if (action === "freeze" || action === "unfreeze") {
    const accountId = parseInt(form.get("account_id"), 10);
    await ledger.setAccountStatus(db, accountId, action === "freeze" ? "frozen" : "active");
    await ledger.audit(db, {
      actorId: user.id,
      action: `account.${action}`,
      targetType: "account",
      targetId: accountId,
    });
    return await pageCustomer(env, db, user, customerId, notice(`Account ${action}d.`, "good"));
  }

  if (action === "open_account") {
    const kind = String(form.get("kind"));
    if (!["checking", "savings"].includes(kind)) return redirect(`/admin/customer/${customerId}`);
    const id = await ledger.openAccount(db, {
      userId: Number(customerId),
      kind,
      label: kind === "savings" ? "Savings" : "Checking",
    });
    await ledger.audit(db, {
      actorId: user.id,
      action: "account.opened_by_staff",
      targetType: "account",
      targetId: id,
      detail: `${kind} for user ${customerId}`,
    });
    return await pageCustomer(env, db, user, customerId, notice(`Opened account #${id}.`, "good"));
  }

  if (action === "close_account") {
    const accountId = parseInt(form.get("account_id"), 10);
    const acct = await ledger.getAccount(db, accountId);
    if (!acct) return redirect(`/admin/customer/${customerId}`);
    // Refusing to close a non-empty account is what stops money being
    // stranded somewhere nobody can reach it.
    if (acct.balance_cents !== 0) {
      return await pageCustomer(
        env, db, user, customerId,
        notice("Empty the account before closing it. Money in a closed account is unreachable.", "bad")
      );
    }
    await ledger.setAccountStatus(db, accountId, "closed");
    await ledger.audit(db, {
      actorId: user.id,
      action: "account.closed",
      targetType: "account",
      targetId: accountId,
    });
    return await pageCustomer(env, db, user, customerId, notice("Account closed.", "good"));
  }

  if (action === "set_rate") {
    const accountId = parseInt(form.get("account_id"), 10);
    const bps = parseInt(form.get("bps"), 10);
    if (!Number.isFinite(accountId) || !Number.isFinite(bps) || bps < 0 || bps > 10000) {
      return await pageCustomer(env, db, user, customerId, notice("Rate must be 0 to 10000 basis points.", "bad"));
    }
    const before = await ledger.getAccount(db, accountId);
    await db.prepare(`UPDATE accounts SET interest_bps = ? WHERE id = ?`).bind(bps, accountId).run();
    await ledger.audit(db, {
      actorId: user.id,
      action: "account.rate_changed",
      targetType: "account",
      targetId: accountId,
      detail: `${before ? before.interest_bps : "?"} -> ${bps} bps`,
    });
    return await pageCustomer(
      env, db, user, customerId,
      notice(bps === 0 ? "Account now follows the global rate." : `Rate fixed at ${(bps / 100).toFixed(2)}% monthly.`, "good")
    );
  }

  if (action === "suspend" || action === "unsuspend") {
    if (Number(customerId) === user.id) {
      return await pageCustomer(env, db, user, customerId, notice("You cannot suspend yourself.", "bad"));
    }
    const status = action === "suspend" ? "suspended" : "active";
    await db.prepare(`UPDATE users SET status = ? WHERE id = ?`).bind(status, customerId).run();
    await ledger.audit(db, {
      actorId: user.id,
      action: `user.${action}`,
      targetType: "user",
      targetId: customerId,
    });
    return await pageCustomer(env, db, user, customerId, notice(`Customer ${status}.`, "good"));
  }

  if (action === "role") {
    if (user.role !== "admin") return new Response("Admins only", { status: 403 });
    if (Number(customerId) === user.id) {
      return await pageCustomer(env, db, user, customerId, notice("You can't change your own role.", "bad"));
    }
    const role = String(form.get("role"));
    if (!["customer", "staff", "admin"].includes(role)) return redirect(`/admin/customer/${customerId}`);
    await db.prepare(`UPDATE users SET role = ? WHERE id = ?`).bind(role, customerId).run();
    await ledger.audit(db, {
      actorId: user.id,
      action: "user.role_changed",
      targetType: "user",
      targetId: customerId,
      detail: role,
    });
    return await pageCustomer(env, db, user, customerId, notice(`Role set to ${esc(role)}.`, "good"));
  }

  return redirect(`/admin/customer/${customerId}`);
}

// ---------------------------------------------------------------------------
// manual adjustment
// ---------------------------------------------------------------------------
export async function pageAdjust(env, db, user, message = "", prefillAccount = "") {
  const body = `<section>
    <a class="muted small" href="/admin">Back to admin</a>
    <h1 style="margin-top:10px">Manual entry</h1>
    ${message}
    ${notice(
      `Credits a customer account from <b>bank equity</b>, or debits one back to it.
       This is real money on the books - it shows up in equity and in the audit log with
       your name on it. Use it for corrections and goodwill, not for routine work.`,
      "warn"
    )}
    <div class="card" style="margin-top:16px">
      <form method="POST" action="/admin/adjust">
        <div class="field"><label>Account number</label>
          <input name="account_id" required value="${esc(prefillAccount)}"></div>
        <div class="field"><label>Direction</label>
          <select name="direction">
            <option value="credit">Credit - give money to the customer</option>
            <option value="debit">Debit - take money back</option>
          </select></div>
        <div class="field"><label>Amount</label><input name="amount" placeholder="0.00" inputmode="decimal" required></div>
        <div class="field"><label>Reason (required, recorded permanently)</label>
          <input name="reason" required maxlength="200" placeholder="e.g. refund for duplicate deposit #41"></div>
        <button class="btn" type="submit">Post entry</button>
      </form>
    </div>
  </section>`;
  return html(layout("Manual entry", body, { user, active: "admin" }));
}

export async function doAdjust(env, db, user, request) {
  const form = await request.formData();
  const accountId = parseInt(form.get("account_id"), 10);
  const direction = String(form.get("direction"));
  const reason = String(form.get("reason") || "").trim();
  const parsed = parseUserAmount(form.get("amount"), { min: 1 });

  if (parsed.error) return await pageAdjust(env, db, user, notice(esc(parsed.error), "bad"));
  if (!reason) return await pageAdjust(env, db, user, notice("A reason is required.", "bad"));

  const account = await ledger.getAccount(db, accountId);
  if (!account || !["checking", "savings"].includes(account.kind)) {
    return await pageAdjust(env, db, user, notice("That is not a customer or company account.", "bad"));
  }

  const amount = direction === "debit" ? -parsed.cents : parsed.cents;

  try {
    await ledger.postEntry(db, {
      kind: "adjustment",
      memo: reason,
      // Random key: each manual entry is a distinct deliberate act, unlike a
      // retryable machine operation.
      idempotencyKey: `adjust:${crypto.randomUUID()}`,
      createdBy: user.id,
      postings: [
        { accountId, amountCents: amount },
        { accountId: ledger.EQUITY_ACCOUNT_ID, amountCents: -amount },
      ],
    });
    await ledger.audit(db, {
      actorId: user.id,
      action: "ledger.manual_adjustment",
      targetType: "account",
      targetId: accountId,
      detail: `${direction} ${money0(parsed.cents)} - ${reason}`,
    });
    return await pageAdjust(
      env, db, user,
      notice(`Posted ${direction} of ${money0(parsed.cents)} to account #${accountId}.`, "good")
    );
  } catch (err) {
    return await pageAdjust(env, db, user, notice(esc(err.message), "bad"));
  }
}

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------
export async function pageReconciliation(env, db, user, message = "") {
  const { results } = await db
    .prepare(`SELECT * FROM reconciliations ORDER BY id DESC LIMIT 30`)
    .all();

  const [unbalanced, mismatches] = await Promise.all([
    ledger.findUnbalancedEntries(db),
    ledger.findBalanceMismatches(db),
  ]);

  const rows = results
    .map(
      (r) => `<tr>
        <td class="muted small">${shortDate(r.created_at)}</td>
        <td class="num">${money0(r.treasury_cents)}</td>
        <td class="num">${money0(r.ledger_cents)}</td>
        <td class="num ${r.drift_cents === 0 ? "pos" : "neg"}">${money0(r.drift_cents)}</td>
        <td>${r.unbalanced_entries} / ${r.balance_mismatches}</td>
      </tr>`
    )
    .join("");

  const problems =
    unbalanced.length || mismatches.length
      ? notice(
          `<b>${unbalanced.length}</b> unbalanced entr(ies) and <b>${mismatches.length}</b>
           account(s) whose cached balance disagrees with their postings.
           Do not "fix" balances until the cause is understood - rebuilding destroys the evidence.`,
          "bad"
        )
      : notice(`Books balance. Every entry sums to zero and every cached balance matches its postings.`, "good");

  const body = `<section>
    <a class="muted small" href="/admin">← Admin</a>
    <h1 style="margin-top:10px">Reconciliation</h1>
    ${message}${problems}
    <div class="card" style="margin-top:16px">
      <table><thead><tr><th>When</th><th style="text-align:right">Treasury</th>
      <th style="text-align:right">Books say</th><th style="text-align:right">Drift</th>
      <th>Unbalanced / mismatched</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="muted">No runs yet.</td></tr>`}</tbody></table>
    </div>
  </section>`;
  return html(layout("Reconciliation", body, { user, active: "admin" }));
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
export async function pageSettings(env, db, user, message = "") {
  const [ratio, savings, paused, cd, loan, credit] = await Promise.all([
    ledger.getSetting(db, "reserve_ratio_bps", "10000"),
    ledger.getSetting(db, "savings_rate_bps", "200"),
    ledger.getSetting(db, "withdrawals_paused", "0"),
    ledger.getSetting(db, "cd_rate_bps", "300"),
    ledger.getSetting(db, "loan_rate_bps", "400"),
    ledger.getSetting(db, "credit_rate_bps", "500"),
  ]);

  const setting = (key, label, value, help) => `
    <div class="card" style="margin-top:14px">
      <form method="POST" action="/admin/settings">
        <input type="hidden" name="key" value="${key}">
        <label>${label}</label>
        <div style="display:flex;gap:10px">
          <input name="value" value="${esc(value)}">
          <button class="btn ghost" type="submit">Save</button>
        </div>
        <p class="muted small" style="margin-bottom:0">${help}</p>
      </form>
    </div>`;

  const body = `<section>
    <a class="muted small" href="/admin">← Admin</a>
    <h1 style="margin-top:10px">Settings</h1>
    ${message}
    ${setting(
      "reserve_ratio_bps",
      "Reserve ratio (basis points) - THIS is the lending switch",
      ratio,
      `10000 = 100% = fully reserved; the bank holds every coin it owes and cannot lend, so
       loans and credit cards are switched OFF. Lowering it below 10000 turns lending ON
       automatically and sets how much can be lent: the gap between what the bank holds and
       this floor. Lowering it also makes a bank run possible, because customer deposits are
       then being lent out. Currently <b>${(Number(ratio) / 100).toFixed(1)}%</b>, lending is
       <b>${Number(ratio) >= 10000 ? "OFF" : "ON"}</b>. Audited.`
    )}
    ${setting("cd_rate_bps", "Fixed deposit rate (bps/month)", cd,
      `Base rate for new fixed deposits. 300 = 3.00%. Business tiers add a bonus on top.`)}
    ${setting("loan_rate_bps", "Standard loan rate (bps/month)", loan,
      `Base loan rate. 400 = 4.00%. Gold takes 0.5% off, Platinum 1.5% off, automatically.`)}
    ${setting("credit_rate_bps", "Credit card rate (bps/month)", credit,
      `Monthly interest on card balances. 500 = 5.00%, as specified.`)}
    ${setting(
      "savings_rate_bps",
      "Savings interest (basis points per month)",
      savings,
      `200 = 2.00% monthly, which compounds to roughly 27% a year. Interest is paid from
       bank equity - if lending income doesn't cover it, equity falls every month.`
    )}
    ${setting(
      "withdrawals_paused",
      "Withdrawals paused",
      paused,
      `1 pauses all customer withdrawals; 0 allows them. Set automatically to 1 if
       reconciliation finds drift.`
    )}
  </section>`;
  return html(layout("Settings", body, { user, active: "admin" }));
}

export async function doSettings(env, db, user, request) {
  if (user.role !== "admin") return new Response("Admins only", { status: 403 });
  const form = await request.formData();
  const key = String(form.get("key"));
  const value = String(form.get("value")).trim();

  if (
    !["reserve_ratio_bps", "savings_rate_bps", "withdrawals_paused", "cd_rate_bps", "loan_rate_bps", "credit_rate_bps"].includes(
      key
    )
  ) {
    return redirect("/admin/settings");
  }
  if (!/^\d+$/.test(value)) {
    return await pageSettings(env, db, user, notice("Value must be a whole number.", "bad"));
  }

  const before = await ledger.getSetting(db, key, "");
  await ledger.setSetting(db, key, value, user.id);
  await ledger.audit(db, {
    actorId: user.id,
    action: "settings.changed",
    targetType: "setting",
    targetId: key,
    detail: `${before} -> ${value}`,
  });

  const extra =
    key === "reserve_ratio_bps" && Number(value) < 10000
      ? notice(
          `Reserve ratio is now below 100%. The bank may lend customer deposits, which
           means it can no longer guarantee every customer can withdraw at once.`,
          "warn"
        )
      : "";

  return await pageSettings(env, db, user, notice("Saved.", "good") + extra);
}

// ---------------------------------------------------------------------------
// businesses
// ---------------------------------------------------------------------------
export async function pageBusinesses(env, db, user, query = "", message = "") {
  const list = await biz.listAllBusinesses(db, { query });

  const rows = list
    .map((b) => {
      const active = biz.perksActive(b);
      return `<tr>
        <td><b>${esc(b.display_name)}</b>
          <div class="muted small">${esc(b.firm_name)}</div></td>
        <td>${esc(b.owner_mc || b.owner_name || "unknown")}</td>
        <td><span class="pill">${esc(b.tier)}</span>
          ${active ? `<span class="pill good">paid</span>` : `<span class="pill warn">unpaid</span>`}</td>
        <td class="num">${money0(b.balance_cents || 0)}</td>
        <td>${b.member_count}</td>
        <td><span class="pill ${b.status === "active" ? "good" : b.status === "closed" ? "bad" : "warn"}">${esc(
        b.status
      )}</span></td>
        <td style="text-align:right"><a class="btn ghost sm" href="/admin/business/${b.id}">Open</a></td>
      </tr>`;
    })
    .join("");

  const body = `<section>
    <a class="muted small" href="/admin">Back to admin</a>
    <h1 style="margin-top:10px">Companies</h1>
    ${message}
    <form method="GET" action="/admin/businesses" style="display:flex;gap:10px;margin:16px 0">
      <input name="q" placeholder="Search firm or display name" value="${esc(query)}">
      <button class="btn ghost" type="submit">Search</button>
    </form>
    <div class="card">
      <table><thead><tr><th>Company</th><th>Owner</th><th>Plan</th>
        <th style="text-align:right">Balance</th><th>People</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="7" class="muted">No companies registered.</td></tr>`}</tbody></table>
    </div>
  </section>`;
  return html(layout("Companies", body, { user, active: "admin" }));
}

export async function pageBusinessDetail(env, db, user, businessId, message = "") {
  const b = await biz.getBusiness(db, businessId);
  if (!b) return html(layout("Not found", `<section><h1>No such company</h1></section>`, { user }), 404);

  const [account, memberList, charges] = await Promise.all([
    biz.businessAccount(db, businessId),
    biz.members(db, businessId),
    biz.chargeHistory(db, businessId, 12),
  ]);

  const memberRows = memberList
    .map(
      (m) => `<tr>
        <td>${esc(m.mc_username || m.discord_username || "unknown")}
          <div class="muted small">${esc(m.discord_username || "")}</div></td>
        <td><span class="pill">${esc(m.role)}</span></td>
        <td style="text-align:right;white-space:nowrap">
          ${
            m.role !== "owner"
              ? `<form method="POST" action="/admin/business/${businessId}" style="display:inline">
                   <input type="hidden" name="action" value="make_owner">
                   <input type="hidden" name="user_id" value="${m.user_id}">
                   <button class="btn ghost sm" type="submit">Make owner</button>
                 </form>
                 <form method="POST" action="/admin/business/${businessId}" style="display:inline">
                   <input type="hidden" name="action" value="remove_member">
                   <input type="hidden" name="user_id" value="${m.user_id}">
                   <button class="btn ghost sm" type="submit">Remove</button>
                 </form>`
              : `<span class="muted small">owner</span>`
          }
        </td></tr>`
    )
    .join("");

  const chargeRows = charges
    .map(
      (c) => `<tr><td>${esc(c.period)}</td><td>${esc(c.tier)}</td>
        <td class="num">${money0(c.amount_cents)}</td>
        <td><span class="pill ${c.status === "paid" ? "good" : "bad"}">${esc(c.status)}</span></td></tr>`
    )
    .join("");

  const act = (action, label, extra = "") => `
    <form method="POST" action="/admin/business/${businessId}" style="display:inline">
      <input type="hidden" name="action" value="${action}">${extra}
      <button class="btn ghost sm" type="submit">${label}</button>
    </form>`;

  const body = `<section>
    <a class="muted small" href="/admin/businesses">Back to companies</a>
    <h1 style="margin-top:10px">${esc(b.display_name)}</h1>
    <p class="muted">${esc(b.firm_name)} · ${esc(biz.tierOf(b).name)} ·
      ${biz.perksActive(b) ? `paid until ${shortDate(b.paid_until)}` : "not paid"} ·
      status ${esc(b.status)}</p>
    ${message}

    <div class="card" style="margin-top:16px">
      <div class="acct-row">
        <div><b>Company account</b>
          <div class="muted small">#${account ? account.id : "none"}
            ${account && account.deposit_code ? `· code ${esc(account.deposit_code)}` : ""}</div></div>
        <div style="text-align:right;font-weight:700">${money0(account ? account.balance_cents : 0)}</div>
      </div>
      ${
        account
          ? `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
               <a class="btn ghost sm" href="/admin/adjust?account=${account.id}">Adjust balance</a>
               <a class="btn ghost sm" href="/app/account/${account.id}">Statement</a>
             </div>`
          : ""
      }
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Plan and billing</h3>
      <form method="POST" action="/admin/business/${businessId}" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <input type="hidden" name="action" value="set_tier">
        <select name="tier" style="width:auto">
          ${Object.values(biz.TIERS)
            .map((t) => `<option value="${t.key}"${b.tier === t.key ? " selected" : ""}>${esc(t.name)}</option>`)
            .join("")}
        </select>
        <button class="btn ghost sm" type="submit">Change plan</button>
      </form>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        ${act("bill_now", "Bill now")}
        ${act("comp", "Grant 1 month free", `<input type="hidden" name="months" value="1">`)}
      </div>
      <p class="muted small" style="margin-top:10px">Billing takes the fee from the company
      account into bank equity. If the account is short, it records as failed and the company
      goes overdue. No money is created either way.</p>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>People</h3>
      <table><tbody>${memberRows || `<tr><td class="muted">No members.</td></tr>`}</tbody></table>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Status</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${act("status", "Set active", `<input type="hidden" name="status" value="active">`)}
        ${act("status", "Suspend", `<input type="hidden" name="status" value="suspended">`)}
        ${act("status", "Close", `<input type="hidden" name="status" value="closed">`)}
      </div>
      <p class="muted small" style="margin-top:10px">Suspending stops perks and billing. It does
      not touch the balance, and the company can still be paid.</p>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Billing history</h3>
      <table><thead><tr><th>Month</th><th>Plan</th>
        <th style="text-align:right">Amount</th><th>Status</th></tr></thead>
      <tbody>${chargeRows || `<tr><td colspan="4" class="muted">Never billed.</td></tr>`}</tbody></table>
    </div>
  </section>`;
  return html(layout(b.display_name, body, { user, active: "admin" }));
}

export async function doBusinessAction(env, db, user, businessId, request) {
  const form = await request.formData();
  const action = String(form.get("action") || "");

  try {
    const b = await biz.getBusiness(db, businessId);
    if (!b) throw new Error("Company not found.");

    if (action === "set_tier") {
      await biz.setTier(db, b, user, String(form.get("tier")));
      return await pageBusinessDetail(env, db, user, businessId, notice("Plan changed.", "good"));
    }
    if (action === "status") {
      await biz.setBusinessStatus(db, businessId, String(form.get("status")), user);
      return await pageBusinessDetail(env, db, user, businessId, notice("Status updated.", "good"));
    }
    if (action === "bill_now") {
      const res = await biz.billNow(db, businessId, user);
      return await pageBusinessDetail(
        env, db, user, businessId,
        res.charged
          ? notice(`Charged ${money0(res.charged)}.`, "good")
          : notice(`Not charged: ${esc(res.reason || res.skipped || "already billed")}`, "warn")
      );
    }
    if (action === "comp") {
      await biz.grantPaidUntil(db, businessId, form.get("months"), user);
      return await pageBusinessDetail(env, db, user, businessId, notice("Time granted.", "good"));
    }
    if (action === "make_owner") {
      await biz.transferOwnership(db, businessId, parseInt(form.get("user_id"), 10), user);
      return await pageBusinessDetail(env, db, user, businessId, notice("Ownership transferred.", "good"));
    }
    if (action === "remove_member") {
      await biz.adminRemoveMember(db, businessId, parseInt(form.get("user_id"), 10), user);
      return await pageBusinessDetail(env, db, user, businessId, notice("Member removed.", "good"));
    }
    return redirect(`/admin/business/${businessId}`);
  } catch (err) {
    return await pageBusinessDetail(env, db, user, businessId, notice(esc(err.message), "bad"));
  }
}

// ---------------------------------------------------------------------------
// webhook registration
// ---------------------------------------------------------------------------
// Deposits are found by polling every 5 minutes. Registering a webhook tells
// the Treasury to push instead, so money lands in seconds. The poller keeps
// running as a safety net; both paths are idempotent on postingId, so a
// deposit seen twice is still credited once.
export async function pageWebhooks(env, db, user, message = "") {
  let existing = [];
  let error = null;
  try {
    const res = await treasury.listWebhooks(env);
    existing = res.webhooks || [];
  } catch (err) {
    error = err.message;
  }

  const expectedUrl = `${env.PUBLIC_URL || "https://your-worker-url"}/webhooks/treasury`;

  const rows = existing
    .map(
      (w) => `<tr>
        <td class="small" style="word-break:break-all">${esc(w.url)}</td>
        <td>${w.active ? `<span class="pill good">active</span>` : `<span class="pill bad">inactive</span>`}</td>
        <td>${w.consecutiveFailures || 0}</td>
        <td style="text-align:right">
          <form method="POST" action="/admin/webhooks" style="display:inline">
            <input type="hidden" name="action" value="delete">
            <input type="hidden" name="id" value="${w.id}">
            <button class="btn ghost sm" type="submit">Remove</button>
          </form>
        </td>
      </tr>`
    )
    .join("");

  const body = `<section>
    <a class="muted small" href="/admin">Back to admin</a>
    <h1 style="margin-top:10px">Deposit notifications</h1>
    ${message}
    ${error ? notice(`Could not reach the Treasury: ${esc(error)}`, "bad") : ""}
    ${notice(
      `Without a webhook, deposits are picked up by a poller every 5 minutes.
       With one, they arrive in seconds. The poller keeps running either way, so
       nothing breaks if the webhook fails.`
    )}

    <div class="card" style="margin-top:16px">
      <h3>Register this bank</h3>
      <p class="muted small">The Treasury will send deposit notifications to:</p>
      <div class="code">${esc(expectedUrl)}</div>
      <p class="muted small" style="margin-top:12px">
        Registering returns a signing secret. You must save it as
        <code>WEBHOOK_SECRET</code> or incoming calls will be rejected.
      </p>
      <form method="POST" action="/admin/webhooks" style="margin-top:12px">
        <input type="hidden" name="action" value="register">
        <button class="btn" type="submit">Register webhook</button>
      </form>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Registered</h3>
      <table><thead><tr><th>URL</th><th>Status</th><th>Failures</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="muted">None registered. Deposits are polled.</td></tr>`}</tbody></table>
    </div>
  </section>`;
  return html(layout("Webhooks", body, { user, active: "admin" }));
}

export async function doWebhookAction(env, db, user, request) {
  if (user.role !== "admin") return new Response("Admins only", { status: 403 });

  const form = await request.formData();
  const action = String(form.get("action") || "");

  if (action === "register") {
    const url = `${env.PUBLIC_URL || ""}/webhooks/treasury`;
    if (!env.PUBLIC_URL) {
      return await pageWebhooks(
        env, db, user,
        notice(`Set <code>PUBLIC_URL</code> in wrangler.toml first, so the Treasury knows where to call.`, "bad")
      );
    }
    try {
      const res = await treasury.registerWebhook(env, url);
      await ledger.audit(db, {
        actorId: user.id,
        action: "webhook.registered",
        targetType: "webhook",
        targetId: res.id,
        detail: url,
      });
      // The secret is shown ONCE. It is not stored here, because storing it in
      // the database would put a credential somewhere it does not belong.
      return await pageWebhooks(
        env, db, user,
        notice(
          `<b>Registered.</b> Save this now, it will not be shown again:
           <div class="code" style="margin-top:10px">${esc(res.secret || "(no secret returned)")}</div>
           <p class="small" style="margin-bottom:0">Then run:
           <code>npx wrangler secret put WEBHOOK_SECRET</code></p>`,
          "good"
        )
      );
    } catch (err) {
      return await pageWebhooks(env, db, user, notice(esc(err.message), "bad"));
    }
  }

  if (action === "delete") {
    const id = parseInt(form.get("id"), 10);
    try {
      await treasury.deleteWebhook(env, id);
      await ledger.audit(db, {
        actorId: user.id,
        action: "webhook.deleted",
        targetType: "webhook",
        targetId: id,
      });
      return await pageWebhooks(env, db, user, notice(`Removed. Deposits fall back to polling.`, "good"));
    } catch (err) {
      return await pageWebhooks(env, db, user, notice(esc(err.message), "bad"));
    }
  }

  return redirect("/admin/webhooks");
}

// ---------------------------------------------------------------------------
// audit log
// ---------------------------------------------------------------------------
export async function pageAudit(env, db, user) {
  const { results } = await db
    .prepare(
      `SELECT a.*, u.discord_username FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.id DESC LIMIT 200`
    )
    .all();

  const rows = results
    .map(
      (a) => `<tr>
        <td class="muted small">${shortDate(a.created_at)}</td>
        <td>${esc(a.discord_username || "system")}</td>
        <td><code>${esc(a.action)}</code></td>
        <td class="small">${esc(a.target_type || "")} ${esc(a.target_id || "")}
          <div class="muted small">${esc((a.detail || "").slice(0, 90))}</div></td>
      </tr>`
    )
    .join("");

  const body = `<section>
    <a class="muted small" href="/admin">← Admin</a>
    <h1 style="margin-top:10px">Audit log</h1>
    <div class="card" style="margin-top:16px">
      <table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="muted">Nothing logged yet.</td></tr>`}</tbody></table>
    </div>
  </section>`;
  return html(layout("Audit", body, { user, active: "admin" }));
}
