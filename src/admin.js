// admin.js — staff dashboard.
// ===========================================================================
// Every action here can move real money, so all of them are POSTs, all of them
// are audit-logged with the actor, and none of them are one-click. Manual
// adjustments require a written reason — an unexplained balance change in a
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
import { parseUserAmount, formatCents } from "./money.js";
import { esc, html, layout, money, signedMoney, shortDate, notice, redirect } from "./views.js";

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
              `<b>Negative equity.</b> The bank owes customers more than it holds — usually
               interest paid out without matching income. This does not fix itself.`,
              "warn"
            )
          : ""
      }`;
  } catch (err) {
    solvencyBlock = notice(`Can't read the Treasury balance: ${esc(err.message)}`, "bad");
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
    ${queues}
    <div class="card" style="margin-top:16px">
      <h3>Tools</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
        <a class="btn ghost sm" href="/admin/customers">Customers</a>
        <a class="btn ghost sm" href="/admin/adjust">Manual entry</a>
        <a class="btn ghost sm" href="/admin/reconciliation">Reconciliation</a>
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
            <td>${esc(w.mc_username || w.to_player_name || "—")}
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
       Never resolve one of these by paying the player manually — that's how someone gets
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
      : notice(`Withdrawal #${id} is still unconfirmed. Leave it — do not pay manually.`, "warn");

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
            <td class="small">${esc(d.memo || "—")}
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
       Assigning moves it out of suspense — it does not create money.`
    )}
    <div class="card" style="margin-top:16px">
      <table><thead><tr><th>When</th><th style="text-align:right">Amount</th>
      <th>Memo / payer</th><th>Assign to</th></tr></thead><tbody>${table}</tbody></table>
    </div>
  </section>`;
  return html(layout("Deposits", body, { user, active: "admin" }));
}

export async function doAssignDeposit(env, db, user, request) {
  const form = await request.formData();
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
        <td>${esc(u.discord_username || "—")}
          <div class="muted small">${esc(u.discord_id)}</div></td>
        <td>${esc(u.mc_username || "—")}
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

  const accounts = await ledger.listUserAccounts(db, c.id);
  const accountRows = accounts
    .map(
      (a) => `<div class="acct-row">
        <div><b>${esc(a.label || a.kind)}</b> <span class="muted small">#${a.id}</span>
          <div class="muted small">${esc(a.kind)} · ${esc(a.status)}
            ${a.deposit_code ? `· code <code>${esc(a.deposit_code)}</code>` : ""}</div></div>
        <div style="text-align:right">
          <div style="font-weight:700">${money0(a.balance_cents)}</div>
          <form method="POST" action="/admin/customer/${c.id}" style="margin-top:6px">
            <input type="hidden" name="action" value="${a.status === "frozen" ? "unfreeze" : "freeze"}">
            <input type="hidden" name="account_id" value="${a.id}">
            <button class="btn ghost sm" type="submit">${a.status === "frozen" ? "Unfreeze" : "Freeze"}</button>
          </form>
        </div>
      </div>`
    )
    .join("");

  const body = `<section>
    <a class="muted small" href="/admin/customers">← Customers</a>
    <h1 style="margin-top:10px">${esc(c.discord_username || "Customer")}</h1>
    <p class="muted">${esc(c.mc_username || "no Minecraft account")}
      ${c.mc_verified_at ? `<span class="pill good">verified</span>` : `<span class="pill">unverified</span>`}
      · role ${esc(c.role)}</p>
    ${message}
    <div class="card" style="margin-top:16px"><h3>Accounts</h3>${accountRows || `<p class="muted">None.</p>`}</div>
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
            ${c.id === user.id ? `<p class="muted small">You can't change your own role.</p>` : ""}
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
export async function pageAdjust(env, db, user, message = "") {
  const body = `<section>
    <a class="muted small" href="/admin">← Admin</a>
    <h1 style="margin-top:10px">Manual entry</h1>
    ${message}
    ${notice(
      `Credits a customer account from <b>bank equity</b>, or debits one back to it.
       This is real money on the books — it shows up in equity and in the audit log with
       your name on it. Use it for corrections and goodwill, not for routine work.`,
      "warn"
    )}
    <div class="card" style="margin-top:16px">
      <form method="POST" action="/admin/adjust">
        <div class="field"><label>Account number</label><input name="account_id" required></div>
        <div class="field"><label>Direction</label>
          <select name="direction">
            <option value="credit">Credit — give money to the customer</option>
            <option value="debit">Debit — take money back</option>
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
    return await pageAdjust(env, db, user, notice("That isn't a customer account.", "bad"));
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
      detail: `${direction} ${money0(parsed.cents)} — ${reason}`,
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
           Do not "fix" balances until the cause is understood — rebuilding destroys the evidence.`,
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
  const [ratio, savings, paused] = await Promise.all([
    ledger.getSetting(db, "reserve_ratio_bps", "10000"),
    ledger.getSetting(db, "savings_rate_bps", "200"),
    ledger.getSetting(db, "withdrawals_paused", "0"),
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
      "Reserve ratio (basis points)",
      ratio,
      `10000 = 100% = fully reserved; the bank holds every coin it owes and cannot lend.
       Lowering this permits lending customer deposits and makes a bank run possible.
       Currently <b>${(Number(ratio) / 100).toFixed(1)}%</b>. This change is audited.`
    )}
    ${setting(
      "savings_rate_bps",
      "Savings interest (basis points per month)",
      savings,
      `200 = 2.00% monthly, which compounds to roughly 27% a year. Interest is paid from
       bank equity — if lending income doesn't cover it, equity falls every month.`
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

  if (!["reserve_ratio_bps", "savings_rate_bps", "withdrawals_paused"].includes(key)) {
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
