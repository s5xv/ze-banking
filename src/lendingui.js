// lendingui.js - screens for loans and credit cards.
// The whole surface reflects the lending gate: when the bank is fully reserved,
// every page here says so plainly and offers nothing, so a customer is never
// shown a product the bank cannot actually provide.

import * as lending from "./lending.js";
import * as ledger from "./ledger.js";
import * as treasury from "./treasury.js";
import { parseUserAmount } from "./money.js";
import { esc, html, layout, money, shortDate, notice, redirect } from "./views.js";

async function gateBanner(env, db) {
  let treasuryCents = null;
  try {
    treasuryCents = await treasury.poolBalanceCents(env);
  } catch {
    return { ok: false, banner: notice("Lending status can't be checked while the Treasury is unreachable.", "warn") };
  }
  const status = await lending.lendingStatus(db, treasuryCents);
  if (!status.enabled) {
    return { ok: false, banner: notice(`<b>Lending is currently unavailable.</b> ${esc(status.reason)}`, "warn"), status };
  }
  return { ok: true, status };
}

// ---------------------------------------------------------------------------
// customer: my loans and cards
// ---------------------------------------------------------------------------
export async function pageBorrowing(env, db, user, message = "") {
  const [loans, cards, accounts] = await Promise.all([
    lending.listLoansForUser(db, user.id),
    lending.listCardsForUser(db, user.id),
    ledger.listUserAccounts(db, user.id),
  ]);

  const payFrom = accounts
    .filter((a) => a.status === "active" && !a.cd_matures_at)
    .map((a) => `<option value="${a.id}">${esc(a.label || a.kind)} - ${money(a.balance_cents)}</option>`)
    .join("");

  const loanRows = loans
    .map((l) => {
      if (l.status === "offered") {
        return `<div class="acct-row">
          <div><b>Loan offer</b> ${money(l.principal_cents)}
            <div class="muted small">${(l.rate_bps / 100).toFixed(2)}% monthly · ${l.term_months} months</div></div>
          <a class="btn sm" href="/app/loan/${esc(l.sign_token)}">Review &amp; sign</a>
        </div>`;
      }
      return `<div class="acct-row">
        <div><b>Loan</b> <span class="muted small">#${l.id}</span>
          <div class="muted small">${(l.rate_bps / 100).toFixed(2)}% monthly · owe ${money(l.outstanding_cents)}</div></div>
        <form method="POST" action="/app/borrow" style="display:flex;gap:6px;flex-wrap:wrap">
          <input type="hidden" name="action" value="repay">
          <input type="hidden" name="loan_id" value="${l.id}">
          <select name="from_id" style="width:auto">${payFrom}</select>
          <input name="amount" placeholder="0.00" style="width:100px" inputmode="decimal" required>
          <button class="btn sm" type="submit">Repay</button>
        </form>
      </div>`;
    })
    .join("");

  const cardRows = cards
    .map((c) => {
      const owed = Math.max(0, -c.balance_cents);
      const available = c.limit_cents - owed;
      return `<div class="card" style="margin-top:14px">
        <div style="display:flex;justify-content:space-between">
          <div><b>Credit card</b>
            <div class="muted small">${(c.rate_bps / 100).toFixed(2)}% monthly on balance</div></div>
          <div style="text-align:right">
            <div style="font-weight:700">${money(owed)} owed</div>
            <div class="muted small">${money(available)} available of ${money(c.limit_cents)}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <form method="POST" action="/app/borrow" style="display:flex;gap:6px;flex-wrap:wrap">
            <input type="hidden" name="action" value="pay_card">
            <input type="hidden" name="card_id" value="${c.id}">
            <select name="from_id" style="width:auto">${payFrom}</select>
            <input name="amount" placeholder="0.00" style="width:100px" inputmode="decimal" required>
            <button class="btn sm" type="submit">Pay off</button>
          </form>
        </div>
      </div>`;
    })
    .join("");

  const body = `<section>
    <h1>Loans &amp; credit</h1>
    ${message}
    <div class="card" style="margin-top:16px">
      <h2>Loans</h2>
      ${loanRows || `<p class="muted">No loans. An admin can offer you one.</p>`}
    </div>
    <h2 style="margin-top:24px">Credit cards</h2>
    ${cardRows || `<p class="muted">No cards. An admin can issue you one.</p>`}
  </section>`;
  return html(layout("Loans & credit", body, { user, active: "borrow" }));
}

export async function doBorrow(env, db, user, request) {
  const form = await request.formData();
  const action = String(form.get("action") || "");
  try {
    const parsed = parseUserAmount(form.get("amount"), { min: 1 });
    if (parsed.error) throw new Error(parsed.error);

    if (action === "repay") {
      const res = await lending.repayLoan(db, user, {
        loanId: parseInt(form.get("loan_id"), 10),
        fromAccountId: parseInt(form.get("from_id"), 10),
        amountCents: parsed.cents,
      });
      return await pageBorrowing(env, db, user,
        notice(`Repaid ${money(res.paid)}. ${res.remaining ? `Still owe ${money(res.remaining)}.` : "Loan cleared."}`, "good"));
    }
    if (action === "pay_card") {
      const res = await lending.payCard(db, user, {
        cardId: parseInt(form.get("card_id"), 10),
        fromAccountId: parseInt(form.get("from_id"), 10),
        amountCents: parsed.cents,
      });
      return await pageBorrowing(env, db, user, notice(`Paid ${money(res.paid)} off the card.`, "good"));
    }
    return redirect("/app/borrow");
  } catch (err) {
    return await pageBorrowing(env, db, user, notice(esc(err.message), "bad"));
  }
}

// ---------------------------------------------------------------------------
// borrower: sign a loan
// ---------------------------------------------------------------------------
export async function pageSignLoan(env, db, user, token, message = "") {
  const loan = await lending.getLoanByToken(db, token);
  if (!loan) return html(layout("Not found", `<section><h1>No such loan offer</h1></section>`, { user }), 404);
  if (loan.borrower_user_id !== user.id) {
    return html(layout("Not yours", `<section><h1>This offer is not for you</h1>
      <p class="muted">A loan offer can only be signed by the person it names.</p></section>`, { user }), 403);
  }

  const decided = loan.status !== "offered";
  const body = `<section style="max-width:640px">
    <h1>Loan agreement</h1>
    ${message}
    <div class="card" style="margin-top:16px">
      <pre style="white-space:pre-wrap;font-family:inherit;margin:0">${esc(loan.contract_text)}</pre>
    </div>
    ${
      decided
        ? notice(`This offer is already <b>${esc(loan.status)}</b>.`, "warn")
        : `<div class="card" style="margin-top:16px">
            <p class="muted small">Signing advances ${money(loan.principal_cents)} to your account
            immediately and creates a debt you agree to repay with interest.</p>
            <form method="POST" action="/app/loan/${esc(token)}">
              <button class="btn" type="submit">I agree and sign</button>
            </form>
          </div>`
    }
  </section>`;
  return html(layout("Sign loan", body, { user }));
}

export async function doSignLoan(env, db, user, token) {
  try {
    const res = await lending.signLoan(env, db, user, token);
    return await pageBorrowing(env, db, user,
      notice(`Signed. ${money(res.advanced)} has been added to your account.`, "good"));
  } catch (err) {
    return await pageSignLoan(env, db, user, token, notice(esc(err.message), "bad"));
  }
}

// ---------------------------------------------------------------------------
// admin: lending desk
// ---------------------------------------------------------------------------
export async function pageLendingAdmin(env, db, user, message = "") {
  const gate = await gateBanner(env, db);

  const [offers, active] = await Promise.all([
    lending.listAllLoans(db, { status: "offered" }),
    lending.listAllLoans(db, { status: "active" }),
  ]);

  const offerRows = offers
    .map(
      (l) => `<tr><td>${esc(l.mc_username)}</td><td class="num">${money(l.principal_cents)}</td>
        <td>${(l.rate_bps / 100).toFixed(2)}%</td>
        <td class="small">link sent</td>
        <td style="text-align:right">
          <form method="POST" action="/admin/lending" style="display:inline">
            <input type="hidden" name="action" value="cancel"><input type="hidden" name="loan_id" value="${l.id}">
            <button class="btn ghost sm" type="submit">Cancel</button></form></td></tr>`
    )
    .join("");

  const activeRows = active
    .map(
      (l) => `<tr><td>${esc(l.mc_username)}</td><td class="num">${money(l.outstanding_cents)}</td>
        <td>${(l.rate_bps / 100).toFixed(2)}%</td><td class="small">${shortDate(l.advanced_at)}</td><td></td></tr>`
    )
    .join("");

  const capacityLine =
    gate.status && gate.status.enabled
      ? `<p class="muted small">Lending headroom: about ${money(gate.status.capacityCents)} before the reserve floor.</p>`
      : "";

  const body = `<section>
    <a class="muted small" href="/admin">Back to admin</a>
    <h1 style="margin-top:10px">Lending desk</h1>
    ${message}
    ${gate.banner || ""}
    ${capacityLine}

    <div class="card" style="margin-top:16px">
      <h3>Offer a loan</h3>
      <p class="muted small" style="margin-top:0">Creates a contract and a signing link. The
      borrower gets the money only when they sign. Tier discounts apply automatically for
      company loans.</p>
      <form method="POST" action="/admin/lending">
        <input type="hidden" name="action" value="offer">
        <div class="row">
          <div class="field"><label>Borrower Minecraft name</label><input name="mc" required></div>
          <div class="field"><label>Company (optional)</label><input name="firm" placeholder="for a business loan"></div>
        </div>
        <div class="row">
          <div class="field"><label>Amount</label><input name="amount" inputmode="decimal" required></div>
          <div class="field"><label>Term</label>
            <select name="term">${[1, 3, 6, 12, 24].map((t) => `<option value="${t}">${t} months</option>`).join("")}</select></div>
        </div>
        <button class="btn" type="submit" ${gate.ok ? "" : "disabled"}>Create offer</button>
      </form>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Issue a credit card</h3>
      <form method="POST" action="/admin/lending">
        <input type="hidden" name="action" value="card">
        <div class="row">
          <div class="field"><label>Holder Minecraft name</label><input name="mc" required></div>
          <div class="field"><label>Credit limit</label><input name="amount" inputmode="decimal" required></div>
        </div>
        <button class="btn" type="submit" ${gate.ok ? "" : "disabled"}>Issue card</button>
      </form>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Offers awaiting signature</h3>
      <table><thead><tr><th>Borrower</th><th style="text-align:right">Amount</th><th>Rate</th><th></th><th></th></tr></thead>
      <tbody>${offerRows || `<tr><td colspan="5" class="muted">None.</td></tr>`}</tbody></table>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Active loans</h3>
      <table><thead><tr><th>Borrower</th><th style="text-align:right">Outstanding</th><th>Rate</th><th>Since</th><th></th></tr></thead>
      <tbody>${activeRows || `<tr><td colspan="5" class="muted">None.</td></tr>`}</tbody></table>
    </div>
  </section>`;
  return html(layout("Lending", body, { user, active: "admin" }));
}

export async function doLendingAdmin(env, db, user, request) {
  const form = await request.formData();
  const action = String(form.get("action") || "");
  try {
    if (action === "offer") {
      const parsed = parseUserAmount(form.get("amount"), { min: 1 });
      if (parsed.error) throw new Error(parsed.error);
      const res = await lending.offerLoan(env, db, user, {
        borrowerMc: form.get("mc"),
        businessFirm: String(form.get("firm") || "").trim() || null,
        principalCents: parsed.cents,
        termMonths: parseInt(form.get("term"), 10),
      });
      const link = `${new URL(request.url).origin}/app/loan/${res.token}`;
      return await pageLendingAdmin(env, db, user,
        notice(`Offer created at ${(res.rateBps / 100).toFixed(2)}%. Send them this link:
          <div class="code" style="margin-top:8px">${esc(link)}</div>`, "good"));
    }
    if (action === "card") {
      const parsed = parseUserAmount(form.get("amount"), { min: 1 });
      if (parsed.error) throw new Error(parsed.error);
      const res = await lending.issueCard(env, db, user, { userMc: form.get("mc"), limitCents: parsed.cents });
      return await pageLendingAdmin(env, db, user,
        notice(`Card issued at ${(res.rateBps / 100).toFixed(2)}% monthly.`, "good"));
    }
    if (action === "cancel") {
      await lending.cancelLoan(db, user, parseInt(form.get("loan_id"), 10));
      return await pageLendingAdmin(env, db, user, notice("Offer cancelled.", "good"));
    }
    return redirect("/admin/lending");
  } catch (err) {
    return await pageLendingAdmin(env, db, user, notice(esc(err.message), "bad"));
  }
}
