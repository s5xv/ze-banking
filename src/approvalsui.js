// approvalsui.js - screens for signing off money.
//   /app/approvals     what this customer can sign, and their own requests
//   /admin/approvals   savings withdrawals waiting on staff

import * as approvals from "./approvals.js";
import * as withdrawals from "./withdrawals.js";
import * as ledger from "./ledger.js";
import { parseUserAmount } from "./money.js";
import { esc, html, layout, money, shortDate, notice, redirect } from "./views.js";

// ---------------------------------------------------------------------------
// customer side
// ---------------------------------------------------------------------------
export async function pageApprovals(env, db, user, message = "") {
  const items = await approvals.listForUser(db, user.id);

  const rows = items.length
    ? items
        .map(
          (p) => `<div class="acct-row">
            <div>
              <div style="font-weight:600">${money(p.amount_cents)} ${
            p.kind === "withdrawal" ? "withdrawal" : "transfer"
          }</div>
              <div class="muted small">from ${esc(p.from_label || "account")} ·
                ${esc(p.memo || "no reference")} · asked ${shortDate(p.created_at)}</div>
              <div class="muted small">${p.have} of ${p.signatures_needed} signatures</div>
            </div>
            <div style="text-align:right;white-space:nowrap">
              ${
                p.mine
                  ? `<span class="pill good">you signed</span>`
                  : `<form method="POST" action="/app/approvals" style="display:inline">
                       <input type="hidden" name="action" value="sign">
                       <input type="hidden" name="id" value="${p.id}">
                       <button class="btn sm" type="submit">Approve</button>
                     </form>`
              }
              <form method="POST" action="/app/approvals" style="display:inline">
                <input type="hidden" name="action" value="reject">
                <input type="hidden" name="id" value="${p.id}">
                <button class="btn ghost sm" type="submit">Reject</button>
              </form>
            </div>
          </div>`
        )
        .join("")
    : `<p class="muted">Nothing waiting.</p>`;

  const body = `<section>
    <h1>Approvals</h1>
    <p class="muted">Payments from your accounts that need signing before they go through.</p>
    ${message}
    <div class="card" style="margin-top:16px">${rows}</div>
    ${notice(
      `Money is not taken out when a request is made. It moves only once enough people have
       approved, and the balance is checked again at that moment. If the money has been spent
       in the meantime, the request is cancelled rather than overdrawing the account.`
    )}
  </section>`;
  return html(layout("Approvals", body, { user, active: "approvals" }));
}

export async function doApproval(env, db, user, request) {
  const form = await request.formData();
  const id = parseInt(form.get("id"), 10);
  const action = String(form.get("action") || "");

  try {
    if (action === "reject") {
      await approvals.reject(db, id, user, form.get("reason"));
      return await pageApprovals(env, db, user, notice("Request rejected.", "good"));
    }

    const res = await approvals.sign(db, id, user);

    if (res.executed) {
      return await pageApprovals(env, db, user, notice("Approved and sent.", "good"));
    }
    if (res.approved) {
      // A withdrawal, fully signed. The Treasury payout lives in
      // withdrawals.js, so it is triggered here rather than inside approvals.
      const out = await withdrawals.performApproved(env, db, id, user);
      return await pageApprovals(
        env, db, user,
        notice(
          out.status === "sent"
            ? "Approved and paid out."
            : "Approved. The payout is being confirmed and will not be sent twice.",
          "good"
        )
      );
    }
    return await pageApprovals(
      env, db, user,
      notice(`Signed. ${res.have} of ${res.need} approvals so far.`, "good")
    );
  } catch (err) {
    return await pageApprovals(env, db, user, notice(esc(err.message), "bad"));
  }
}

// ---------------------------------------------------------------------------
// joint account settings, shown on the account page
// ---------------------------------------------------------------------------
export async function jointBlock(db, account, user) {
  if (account.owner_user_id !== user.id) return "";
  if (account.cd_matures_at) return ""; // fixed deposits are locked anyway

  const signers = await approvals.listSigners(db, account.id);

  const signerRows = signers
    .map(
      (s) => `<div class="acct-row">
        <div>${esc(s.mc_username || s.discord_username || "unknown")}</div>
        <form method="POST" action="/app/joint" style="display:inline">
          <input type="hidden" name="action" value="remove_signer">
          <input type="hidden" name="account_id" value="${account.id}">
          <input type="hidden" name="user_id" value="${s.user_id}">
          <button class="btn ghost sm" type="submit">Remove</button>
        </form>
      </div>`
    )
    .join("");

  return `<div class="card" style="margin-top:16px">
    <h3>Joint control</h3>
    <p class="muted small" style="margin-top:0">Add up to three people who must approve large
    payments from this account. Below the threshold it behaves normally.</p>
    ${signerRows || `<p class="muted small">No other signers.</p>`}

    <form method="POST" action="/app/joint" style="margin-top:14px">
      <input type="hidden" name="action" value="add_signer">
      <input type="hidden" name="account_id" value="${account.id}">
      <div class="field"><label>Add signer by Minecraft username</label>
        <input name="mc" maxlength="16"></div>
      <button class="btn ghost sm" type="submit">Add signer</button>
    </form>

    <form method="POST" action="/app/joint" style="margin-top:18px">
      <input type="hidden" name="action" value="rules">
      <input type="hidden" name="account_id" value="${account.id}">
      <div class="row">
        <div class="field"><label>Approval needed at or above</label>
          <input name="threshold" placeholder="blank for never" inputmode="decimal"
            value="${account.joint_threshold_cents ? (account.joint_threshold_cents / 100).toFixed(2) : ""}"></div>
        <div class="field"><label>Signatures required</label>
          <select name="signatures">
            ${[1, 2, 3]
              .map(
                (n) =>
                  `<option value="${n}"${
                    (account.signatures_required || 1) === n ? " selected" : ""
                  }>${n}</option>`
              )
              .join("")}
          </select></div>
      </div>
      <button class="btn ghost sm" type="submit">Save rules</button>
    </form>
    <p class="muted small">You cannot require more signatures than you have signers, because
    that would lock the account with no way to approve anything.</p>
  </div>`;
}

export async function doJoint(env, db, user, request) {
  const form = await request.formData();
  const accountId = parseInt(form.get("account_id"), 10);
  const action = String(form.get("action") || "");

  const account = await ledger.getAccount(db, accountId);
  if (!account || account.owner_user_id !== user.id) return redirect("/app");

  try {
    if (action === "add_signer") {
      await approvals.addSigner(db, account, user, form.get("mc"));
    } else if (action === "remove_signer") {
      await approvals.removeSigner(db, account, user, parseInt(form.get("user_id"), 10));
    } else if (action === "rules") {
      const raw = String(form.get("threshold") || "").trim();
      let cents = null;
      if (raw) {
        const parsed = parseUserAmount(raw, { min: 1 });
        if (parsed.error) throw new Error(parsed.error);
        cents = parsed.cents;
      }
      await approvals.setJointRules(db, account, user, {
        thresholdCents: cents,
        signaturesRequired: form.get("signatures"),
      });
    }
  } catch (err) {
    // Surfaced on the account page rather than an error screen.
    return redirect(`/app/account/${accountId}?err=${encodeURIComponent(err.message)}`);
  }
  return redirect(`/app/account/${accountId}`);
}

// ---------------------------------------------------------------------------
// staff side
// ---------------------------------------------------------------------------
export async function pageStaffApprovals(env, db, user, message = "") {
  const items = await approvals.listForStaff(db);

  const rows = items.length
    ? items
        .map(
          (p) => `<tr>
            <td>${esc(p.mc_username || p.discord_username || "unknown")}
              <div class="muted small">${shortDate(p.created_at)}</div></td>
            <td>${esc(p.from_label || "account")}
              <div class="muted small">${esc(p.from_kind)}</div></td>
            <td class="num">${money(p.amount_cents)}</td>
            <td class="small">${esc(p.memo || "")}</td>
            <td style="text-align:right;white-space:nowrap">
              <form method="POST" action="/admin/approvals" style="display:inline">
                <input type="hidden" name="action" value="approve">
                <input type="hidden" name="id" value="${p.id}">
                <button class="btn sm" type="submit">Approve</button>
              </form>
              <form method="POST" action="/admin/approvals" style="display:inline">
                <input type="hidden" name="action" value="reject">
                <input type="hidden" name="id" value="${p.id}">
                <button class="btn ghost sm" type="submit">Reject</button>
              </form>
            </td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="muted">Nothing waiting.</td></tr>`;

  const body = `<section>
    <a class="muted small" href="/admin">Back to admin</a>
    <h1 style="margin-top:10px">Withdrawal approvals</h1>
    ${message}
    ${notice(
      `Savings withdrawals wait here for staff. Approving one pays it out immediately.
       You cannot approve a request you made yourself.`
    )}
    <div class="card" style="margin-top:16px">
      <table><thead><tr><th>Customer</th><th>Account</th>
        <th style="text-align:right">Amount</th><th>Reference</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
  </section>`;
  return html(layout("Approvals", body, { user, active: "admin" }));
}

export async function doStaffApproval(env, db, user, request) {
  const form = await request.formData();
  const id = parseInt(form.get("id"), 10);
  const action = String(form.get("action") || "");

  try {
    if (action === "reject") {
      await approvals.reject(db, id, user, "Declined by staff");
      return await pageStaffApprovals(env, db, user, notice("Rejected.", "good"));
    }

    await approvals.sign(db, id, user);
    const out = await withdrawals.performApproved(env, db, id, user);

    return await pageStaffApprovals(
      env, db, user,
      notice(
        out.status === "sent"
          ? `Approved and paid.`
          : `Approved. The payout is being confirmed and will not be sent twice.`,
        "good"
      )
    );
  } catch (err) {
    return await pageStaffApprovals(env, db, user, notice(esc(err.message), "bad"));
  }
}
