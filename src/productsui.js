// productsui.js - customer pages for fixed deposits, goals and scheduled payments.

import * as ledger from "./ledger.js";
import * as products from "./products.js";
import * as directdebits from "./directdebits.js";
import { parseUserAmount } from "./money.js";
import { esc, html, layout, money, shortDate, notice, redirect } from "./views.js";

// ---------------------------------------------------------------------------
// fixed deposits
// ---------------------------------------------------------------------------
export async function pageSavings(env, db, user, message = "") {
  const accounts = await ledger.listUserAccounts(db, user.id);
  const cds = await products.listCds(db, user.id);
  const openAccounts = accounts.filter((a) => a.status === "active" && !a.cd_matures_at);

  const baseRate = parseInt(await ledger.getSetting(db, "cd_rate_bps", "300"), 10) || 0;

  const cdRows = cds.length
    ? cds
        .map((c) => {
          const matured = products.cdMatured(c);
          return `<div class="acct-row">
            <div>
              <div style="font-weight:600">${esc(c.label || "Fixed deposit")}</div>
              <div class="muted small">${(c.interest_bps / 100).toFixed(2)}% monthly ·
                ${matured ? "matured" : `locked until ${shortDate(c.cd_matures_at).slice(0, 10)}`}</div>
            </div>
            <div style="text-align:right">
              <div style="font-weight:700">${money(c.balance_cents)}</div>
              ${
                matured
                  ? `<span class="pill good">available</span>`
                  : `<span class="pill warn">locked</span>`
              }
            </div>
          </div>`;
        })
        .join("")
    : `<p class="muted">No fixed deposits yet.</p>`;

  const options = openAccounts
    .map((a) => `<option value="${a.id}">${esc(a.label || a.kind)} - ${money(a.balance_cents)}</option>`)
    .join("");

  const body = `<section>
    <h1>Fixed deposits</h1>
    <p class="muted">Lock money away for a set term and earn a higher rate than instant savings.
    Currently ${(baseRate / 100).toFixed(2)}% a month. Company accounts on Gold and Platinum
    earn a bonus on top.</p>
    ${message}

    <div class="card" style="margin-top:16px">
      <h2>Your deposits</h2>
      ${cdRows}
    </div>

    ${
      openAccounts.length
        ? `<div class="card" style="margin-top:16px">
            <h3>Open a fixed deposit</h3>
            <form method="POST" action="/app/savings">
              <div class="field"><label>Take the money from</label>
                <select name="from_id" required>${options}</select></div>
              <div class="field"><label>Amount</label>
                <input name="amount" placeholder="0.00" inputmode="decimal" required></div>
              <div class="field"><label>Term</label>
                <select name="term">
                  ${products.CD_TERMS.map(
                    (t) => `<option value="${t}">${t} month${t === 1 ? "" : "s"}</option>`
                  ).join("")}
                </select></div>
              <button class="btn" type="submit">Open deposit</button>
            </form>
            <p class="muted small">The rate is fixed when you open it, so a later change to the
            advertised rate will not affect this deposit. You cannot take the money out before
            the term ends.</p>
          </div>`
        : `<div class="empty" style="margin-top:16px">You need an account with money in it first.</div>`
    }
  </section>`;
  return html(layout("Fixed deposits", body, { user, active: "savings" }));
}

export async function doOpenCd(env, db, user, request) {
  const form = await request.formData();
  const parsed = parseUserAmount(form.get("amount"), { min: 100 });
  if (parsed.error) return await pageSavings(env, db, user, notice(esc(parsed.error), "bad"));

  try {
    const res = await products.openCd(db, {
      user,
      fromAccountId: parseInt(form.get("from_id"), 10),
      amountCents: parsed.cents,
      termMonths: parseInt(form.get("term"), 10),
    });
    return await pageSavings(
      env, db, user,
      notice(
        `Opened a ${res.months} month deposit of ${money(parsed.cents)} at
         ${(res.rate / 100).toFixed(2)}% monthly.`,
        "good"
      )
    );
  } catch (err) {
    return await pageSavings(env, db, user, notice(esc(err.message), "bad"));
  }
}

// ---------------------------------------------------------------------------
// savings goals
// ---------------------------------------------------------------------------
export async function doSetGoal(env, db, user, request) {
  const form = await request.formData();
  const accountId = parseInt(form.get("account_id"), 10);
  const raw = String(form.get("amount") || "").trim();

  try {
    if (!raw) {
      await products.setGoal(db, user, accountId, { goalCents: null, label: null });
    } else {
      const parsed = parseUserAmount(raw, { min: 1 });
      if (parsed.error) throw new Error(parsed.error);
      await products.setGoal(db, user, accountId, {
        goalCents: parsed.cents,
        label: form.get("label"),
      });
    }
  } catch {
    // A bad goal is not worth an error page; it is a display setting.
  }
  return redirect(`/app/account/${accountId}`);
}

// ---------------------------------------------------------------------------
// scheduled payments
// ---------------------------------------------------------------------------
export async function pageScheduled(env, db, user, message = "") {
  const [accounts, schedules] = await Promise.all([
    ledger.listUserAccounts(db, user.id),
    products.listSchedules(db, user.id),
  ]);

  const usable = accounts.filter((a) => a.status === "active" && !a.cd_matures_at);

  const rows = schedules.length
    ? schedules
        .map(
          (s) => `<tr>
            <td>${esc(s.to_person || s.to_company || s.to_label || "account")}
              <div class="muted small">from ${esc(s.from_label || "")}</div></td>
            <td class="num">${money(s.amount_cents)}</td>
            <td>${esc(s.frequency)}</td>
            <td>${esc(String(s.next_run).slice(0, 10))}
              ${
                s.status === "paused"
                  ? `<div class="muted small">paused: ${esc((s.last_status || "").slice(0, 40))}</div>`
                  : ""
              }</td>
            <td><span class="pill ${s.status === "active" ? "good" : "warn"}">${esc(s.status)}</span></td>
            <td style="text-align:right;white-space:nowrap">
              <form method="POST" action="/app/scheduled" style="display:inline">
                <input type="hidden" name="action" value="${s.status === "active" ? "pause" : "resume"}">
                <input type="hidden" name="id" value="${s.id}">
                <button class="btn ghost sm" type="submit">${s.status === "active" ? "Pause" : "Resume"}</button>
              </form>
              <form method="POST" action="/app/scheduled" style="display:inline">
                <input type="hidden" name="action" value="cancel">
                <input type="hidden" name="id" value="${s.id}">
                <button class="btn ghost sm" type="submit">Cancel</button>
              </form>
            </td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="muted">Nothing scheduled.</td></tr>`;

  const options = usable
    .map((a) => `<option value="${a.id}">${esc(a.label || a.kind)} - ${money(a.balance_cents)}</option>`)
    .join("");

  const body = `<section>
    <h1>Scheduled payments</h1>
    <p class="muted">Pay someone the same amount every week or month, automatically.</p>
    ${message}

    <div class="card" style="margin-top:16px">
      <table><thead><tr><th>To</th><th style="text-align:right">Amount</th><th>Every</th>
        <th>Next</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>New scheduled payment</h3>
      <form method="POST" action="/app/scheduled">
        <input type="hidden" name="action" value="create">
        <div class="field"><label>From</label><select name="from_id" required>${options}</select></div>
        <div class="field"><label>To (Minecraft username)</label>
          <input name="to" required maxlength="16"></div>
        <div class="field"><label>Amount</label>
          <input name="amount" placeholder="0.00" inputmode="decimal" required></div>
        <div class="field"><label>Frequency</label>
          <select name="frequency">
            <option value="monthly">Every month</option>
            <option value="weekly">Every week</option>
          </select></div>
        <div class="field"><label>First payment on</label><input name="first_run" type="date"></div>
        <div class="field"><label>Reference</label><input name="memo" maxlength="80"></div>
        <button class="btn" type="submit">Create</button>
      </form>
      <p class="muted small">If the account is short on the day, we retry on the next cycle.
      After three failures it pauses itself rather than trying forever.</p>
    </div>
  </section>`;
  return html(layout("Scheduled", body, { user, active: "scheduled" }));
}

// ---------------------------------------------------------------------------
// direct debits, payer side
// ---------------------------------------------------------------------------
export async function pageDebits(env, db, user, message = "") {
  const [accounts, mandates] = await Promise.all([
    ledger.listUserAccounts(db, user.id),
    directdebits.listForPayer(db, user.id),
  ]);

  const usable = accounts.filter((a) => a.status === "active" && !a.cd_matures_at);

  const rows = mandates.length
    ? mandates
        .map(
          (d) => `<tr>
            <td>${esc(d.company || "company")}
              <div class="muted small">${esc(d.reference || "no reference")}</div></td>
            <td>${esc(d.from_label || "account")}</td>
            <td class="num">${money(d.max_cents)}</td>
            <td class="muted small">${
              d.last_pulled_at ? `last ${shortDate(d.last_pulled_at).slice(0, 10)}` : "never used"
            }<div>${money(d.total_pulled_cents)} total</div></td>
            <td style="text-align:right">
              <form method="POST" action="/app/debits">
                <input type="hidden" name="action" value="revoke">
                <input type="hidden" name="id" value="${d.id}">
                <button class="btn ghost sm" type="submit">Cancel</button>
              </form>
            </td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="muted">No direct debits set up.</td></tr>`;

  const options = usable
    .map((a) => `<option value="${a.id}">${esc(a.label || a.kind)} - ${money(a.balance_cents)}</option>`)
    .join("");

  const body = `<section>
    <h1>Direct debits</h1>
    <p class="muted">Let a company collect payments from your account, up to a limit you set.</p>
    ${message}

    <div class="card" style="margin-top:16px">
      <table><thead><tr><th>Company</th><th>From</th>
        <th style="text-align:right">Max per collection</th><th>Activity</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Authorise a company</h3>
      <form method="POST" action="/app/debits">
        <input type="hidden" name="action" value="create">
        <div class="field"><label>Pay from</label><select name="from_id" required>${options}</select></div>
        <div class="field"><label>Company name, as registered with us</label>
          <input name="firm" required maxlength="40"></div>
        <div class="field"><label>Most they can take in one collection</label>
          <input name="max" placeholder="0.00" inputmode="decimal" required></div>
        <div class="field"><label>What it is for</label><input name="reference" maxlength="80"></div>
        <button class="btn" type="submit">Authorise</button>
      </form>
    </div>

    ${notice(
      `You are in control. They can never take more than your limit in one go, you can cancel
       instantly at any time without asking them, and a collection that would overdraw you is
       refused rather than putting you in the red.`
    )}
  </section>`;
  return html(layout("Direct debits", body, { user, active: "debits" }));
}

export async function doDebits(env, db, user, request) {
  const form = await request.formData();
  const action = String(form.get("action") || "");

  try {
    if (action === "revoke") {
      await directdebits.revoke(db, user, parseInt(form.get("id"), 10));
      return await pageDebits(env, db, user, notice("Direct debit cancelled.", "good"));
    }

    const parsed = parseUserAmount(form.get("max"), { min: 1 });
    if (parsed.error) throw new Error(parsed.error);

    await directdebits.createMandate(db, user, {
      fromAccountId: parseInt(form.get("from_id"), 10),
      firmName: form.get("firm"),
      maxCents: parsed.cents,
      reference: form.get("reference"),
    });
    return await pageDebits(env, db, user, notice("Authorised.", "good"));
  } catch (err) {
    return await pageDebits(env, db, user, notice(esc(err.message), "bad"));
  }
}

export async function doScheduled(env, db, user, request) {
  const form = await request.formData();
  const action = String(form.get("action") || "");

  try {
    if (action === "create") {
      const parsed = parseUserAmount(form.get("amount"), { min: 1 });
      if (parsed.error) throw new Error(parsed.error);

      const toName = String(form.get("to") || "").trim();
      const target = await db
        .prepare(
          `SELECT * FROM users WHERE LOWER(mc_username) = LOWER(?)
             AND mc_verified_at IS NOT NULL AND status = 'active'`
        )
        .bind(toName)
        .first();
      if (!target) throw new Error(`No verified customer called "${toName}".`);

      const toAccount = await ledger.defaultAccountForUser(db, target.id);
      if (!toAccount) throw new Error("That customer has no account to receive into.");

      await products.createSchedule(db, user, {
        fromAccountId: parseInt(form.get("from_id"), 10),
        toAccountId: toAccount.id,
        amountCents: parsed.cents,
        memo: form.get("memo"),
        frequency: String(form.get("frequency")),
        firstRun: form.get("first_run"),
      });
      return await pageScheduled(env, db, user, notice("Scheduled.", "good"));
    }

    const id = parseInt(form.get("id"), 10);
    const status = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
    await products.setScheduleStatus(db, user, id, status);
    return await pageScheduled(env, db, user, notice(`Payment ${status}.`, "good"));
  } catch (err) {
    return await pageScheduled(env, db, user, notice(esc(err.message), "bad"));
  }
}
