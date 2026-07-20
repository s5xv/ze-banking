// customer.js - the pages a customer actually uses.
//   /app              accounts overview
//   /app/account/:id  statement
//   /app/deposit      permanent deposit code
//   /app/withdraw     money out (requires verified Minecraft ownership)
//   /app/transfer     instant internal transfer to another customer
//   /app/verify       prove you own a Minecraft account

import * as ledger from "./ledger.js";
import * as auth from "./auth.js";
import * as withdrawals from "./withdrawals.js";
import * as deposits from "./deposits.js";
import * as products from "./products.js";
import { parseUserAmount } from "./money.js";
import { esc, html, layout, money, signedMoney, shortDate, notice, redirect, payCommand } from "./views.js";

// ---------------------------------------------------------------------------
// public landing page
// ---------------------------------------------------------------------------
export async function pageLanding(env, db, user) {
  // Rates come from settings, so changing them in admin updates the marketing
  // copy too - no redeploy, and no chance of advertising a rate we don't pay.
  let savingsPct = "2.00";
  let customers = 0;
  try {
    const bps = await ledger.getSetting(db, "savings_rate_bps", "200");
    savingsPct = (Number(bps) / 100).toFixed(2);
    const r = await db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE mc_verified_at IS NOT NULL`)
      .first();
    customers = r ? r.n : 0;
  } catch {
    // Database not migrated yet - the page still renders.
  }

  const cta = user
    ? `<a class="btn" href="/app">Go to your accounts</a>`
    : `<a class="btn" href="/auth/login">Open an account</a>`;

  const body = `
  <section style="padding:64px 0 40px">
    <h1 style="font-size:40px;letter-spacing:-1px;max-width:16ch">Banking for DemocracyCraft.</h1>
    <p class="muted" style="font-size:17px;max-width:52ch;margin-top:10px">
      Hold your money somewhere safe, send it instantly to anyone, and earn
      ${esc(savingsPct)}% a month on savings. Deposits and withdrawals settle in game.
    </p>
    <div style="display:flex;gap:12px;margin-top:24px;flex-wrap:wrap">
      ${cta}
      <a class="btn ghost" href="#how">How it works</a>
    </div>
    ${customers ? `<p class="muted small" style="margin-top:18px">${customers} verified customer${customers === 1 ? "" : "s"}.</p>` : ""}
  </section>

  <section style="padding-top:0">
    <div class="cards c3">
      <div class="card">
        <h3>Instant transfers</h3>
        <p class="muted small">Send money to any other customer immediately. It never leaves
        the bank, so there's no delay and no fee.</p>
      </div>
      <div class="card">
        <h3>${esc(savingsPct)}% monthly savings</h3>
        <p class="muted small">Interest is paid into your savings account at the start of
        every month. Nothing to claim.</p>
      </div>
      <div class="card">
        <h3>Deposit any time</h3>
        <p class="muted small">You get a permanent payment code. Pay it in game and your
        balance updates within a minute.</p>
      </div>
    </div>
  </section>

  <section id="how">
    <h2>How it works</h2>
    <div class="card">
      <div class="acct-row">
        <div><b>1. Sign in with Discord</b>
          <div class="muted small">Your account is created automatically.</div></div>
      </div>
      <div class="acct-row">
        <div><b>2. Verify your Minecraft account</b>
          <div class="muted small">Send a small payment with a code we give you. It proves
          the account is yours, and the money is credited to your balance - it isn't a fee.</div></div>
      </div>
      <div class="acct-row">
        <div><b>3. Deposit, spend, save</b>
          <div class="muted small">Pay your deposit code any time to top up. Withdraw back to
          your Minecraft account whenever you want.</div></div>
      </div>
    </div>
  </section>

  <section>
    <h2>Where your money actually is</h2>
    <div class="card">
      <p class="muted small" style="margin-top:0">
        Deposits are held in the bank's Treasury account. Every balance is recorded in a
        double-entry ledger, and the books are automatically checked against the Treasury
        every hour - if they ever disagree, withdrawals pause until a human has looked at it.
        We'd rather be briefly unavailable than quietly wrong.
      </p>
    </div>
  </section>`;

  return html(layout("Z&E Bank", body, { user }));
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------
export async function pageHome(env, db, user) {
  const accounts = await ledger.listUserAccounts(db, user.id);
  const total = accounts.reduce((n, a) => n + a.balance_cents, 0);

  // Spending alerts. Derived at render time from thresholds on the account
  // rather than written by a background job, so they can never be stale or
  // describe a balance that has since changed.
  const lowBalance = accounts.filter(
    (a) => a.alert_below_cents && a.balance_cents < a.alert_below_cents
  );
  const alertBanner = lowBalance.length
    ? notice(
        `<b>Low balance.</b> ` +
          lowBalance
            .map(
              (a) =>
                `${esc(a.label || a.kind)} is at ${money(a.balance_cents)}, below your
                 ${money(a.alert_below_cents)} alert.`
            )
            .join(" "),
        "warn"
      )
    : "";

  const verifyBanner = auth.isVerified(user)
    ? ""
    : notice(
        `<b>Verify your Minecraft account</b> to enable withdrawals.
         You can receive and hold money without it, but we won't send money to an
         unproven account. <a href="/app/verify">Verify now →</a>`,
        "warn"
      );

  const rows = accounts.length
    ? accounts
        .map(
          (a) => `<div class="acct-row">
            <div>
              <div style="font-weight:600">${esc(a.label || a.kind)}</div>
              <div class="muted small">${esc(a.kind)}${
            a.interest_bps ? ` · ${(a.interest_bps / 100).toFixed(2)}% monthly` : ""
          }${a.status !== "active" ? ` · <span class="pill bad">${esc(a.status)}</span>` : ""}</div>
            </div>
            <div style="text-align:right">
              <div style="font-weight:700;font-variant-numeric:tabular-nums">${money(a.balance_cents)}</div>
              <a class="small muted" href="/app/account/${a.id}">Statement →</a>
            </div>
          </div>`
        )
        .join("")
    : `<div class="empty">No accounts yet.</div>`;

  // Offer savings only if they haven't got one. Rate comes from settings so
  // the offer always matches what actually gets paid.
  const hasSavings = accounts.some((a) => a.kind === "savings");
  let savingsOffer = "";
  if (!hasSavings) {
    const bps = await ledger.getSetting(db, "savings_rate_bps", "200");
    savingsOffer = `<div class="card" style="margin-top:16px">
      <h3>Open a savings account</h3>
      <p class="muted small">Earn ${(Number(bps) / 100).toFixed(2)}% a month, paid at the
      start of each month. Interest is calculated on your balance at the start of the
      month, so money deposited part way through starts earning from the next one.</p>
      <form method="POST" action="/app/accounts/open">
        <input type="hidden" name="kind" value="savings">
        <button class="btn" type="submit">Open savings account</button>
      </form>
    </div>`;
  }

  const body = `<section>
    <h1>Your money</h1>
    <p class="muted">Signed in as ${esc(user.discord_username)}${
    user.mc_username ? ` · ${esc(user.mc_username)}` : ""
  }</p>
    ${alertBanner}${verifyBanner}
    <div class="card" style="margin-top:18px">
      <div class="muted small">Total balance</div>
      <div class="balance">${money(total)}</div>
      <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
        <a class="btn" href="/app/deposit">Deposit</a>
        <a class="btn ghost" href="/app/withdraw">Withdraw</a>
        <a class="btn ghost" href="/app/transfer">Transfer</a>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h2>Accounts</h2>
      ${rows}
    </div>
    ${savingsOffer}
  </section>`;
  return html(layout("Accounts", body, { user, active: "home" }));
}

/** Open an additional account. Currently savings only. */
export async function doOpenAccount(env, db, user, request) {
  const form = await request.formData();
  const kind = String(form.get("kind") || "");
  if (kind !== "savings") return redirect("/app");

  const existing = await ledger.listUserAccounts(db, user.id);
  if (existing.some((a) => a.kind === "savings")) return redirect("/app");

  const bps = parseInt(await ledger.getSetting(db, "savings_rate_bps", "200"), 10) || 0;
  // interest_bps is left at 0 so the account follows the global rate. A
  // non-zero value here would pin it, which is for fixed-rate products later.
  const id = await ledger.openAccount(db, {
    userId: user.id,
    kind: "savings",
    label: "Savings",
    interestBps: 0,
  });

  await ledger.audit(db, {
    actorId: user.id,
    action: "account.opened",
    targetType: "account",
    targetId: id,
    detail: `savings at ${bps} bps`,
  });

  return redirect("/app");
}

// ---------------------------------------------------------------------------
// statement
// ---------------------------------------------------------------------------
export async function pageAccount(env, db, user, accountId) {
  const account = await ledger.getAccount(db, accountId);
  if (!account || account.owner_user_id !== user.id) {
    return html(layout("Not found", `<section><h1>Account not found</h1>
      <a class="muted" href="/app">← Back</a></section>`, { user }), 404);
  }

  const lines = await ledger.accountStatement(db, accountId, { limit: 60 });
  const rows = lines.length
    ? lines
        .map(
          (l) => `<tr>
            <td class="muted small">${shortDate(l.entry_at)}</td>
            <td>${esc(l.memo || l.kind)}<div class="muted small">${esc(l.kind)}</div></td>
            <td class="num">${signedMoney(l.amount_cents)}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="muted">No transactions yet.</td></tr>`;

  // Savings goal. Display only, so there is nothing here that can move money.
  const progress = products.goalProgress(account);
  const goalBlock =
    account.kind === "savings" && !account.cd_matures_at
      ? `<div class="card" style="margin-top:16px">
          <h3>Savings goal</h3>
          ${
            progress
              ? `<div class="muted small">${esc(account.goal_label || "Goal")} ·
                   ${money(account.balance_cents)} of ${money(account.goal_cents)}</div>
                 <div style="background:var(--panel2);border-radius:999px;height:10px;margin-top:10px;overflow:hidden">
                   <div style="width:${progress.pct}%;height:100%;background:var(${
                  progress.reached ? "--good" : "--accent"
                })"></div>
                 </div>
                 <div class="muted small" style="margin-top:8px">${progress.pct}%${
                  progress.reached ? ", reached" : ""
                }</div>`
              : `<p class="muted small">No goal set.</p>`
          }
          <form method="POST" action="/app/goal" style="margin-top:14px">
            <input type="hidden" name="account_id" value="${account.id}">
            <div class="row">
              <div class="field"><label>Target amount</label>
                <input name="amount" placeholder="leave blank to clear" inputmode="decimal"
                  value="${account.goal_cents ? (account.goal_cents / 100).toFixed(2) : ""}"></div>
              <div class="field"><label>What for</label>
                <input name="label" maxlength="60" value="${esc(account.goal_label || "")}"></div>
            </div>
            <button class="btn ghost sm" type="submit">Save goal</button>
          </form>
        </div>`
      : "";

  const body = `<section>
    <a class="muted small" href="/app">Back to accounts</a>
    <h1 style="margin-top:10px">${esc(account.label || account.kind)}</h1>
    <div class="balance">${money(account.balance_cents)}</div>
    ${
      account.cd_matures_at
        ? `<p class="muted small">Fixed deposit at ${(account.interest_bps / 100).toFixed(2)}% monthly ·
             ${
               products.cdMatured(account)
                 ? "matured, available to move"
                 : `locked until ${shortDate(account.cd_matures_at).slice(0, 10)}`
             }</p>`
        : `<p class="muted small">Deposit code <code>${esc(account.deposit_code || "none")}</code></p>`
    }
    ${goalBlock}

    <div class="card" style="margin-top:16px">
      <h3>Alerts</h3>
      <p class="muted small" style="margin-top:0">Warn me when this account drops below a set
      amount. Shown on your accounts page.</p>
      <form method="POST" action="/app/alerts" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        <input type="hidden" name="account_id" value="${account.id}">
        <div class="field" style="margin-bottom:0;flex:1;min-width:180px">
          <label>Alert below</label>
          <input name="below" placeholder="leave blank for none" inputmode="decimal"
            value="${account.alert_below_cents ? (account.alert_below_cents / 100).toFixed(2) : ""}">
        </div>
        <button class="btn ghost sm" type="submit">Save</button>
      </form>
    </div>

    <div class="card" style="margin-top:18px">
      <table><thead><tr><th>When</th><th>Detail</th><th style="text-align:right">Amount</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
  </section>`;
  return html(layout("Statement", body, { user, active: "home" }));
}

// ---------------------------------------------------------------------------
// deposit - permanent code, no form needed
// ---------------------------------------------------------------------------
export async function pageDeposit(env, db, user) {
  const accounts = await ledger.listUserAccounts(db, user.id);
  const blocks = accounts
    .map(
      (a) => `<div class="card" style="margin-top:14px">
        <h3>${esc(a.label || a.kind)}</h3>
        <p class="muted small">Pay this in game. The code is permanent - reuse it every time.</p>
        <div class="code">${esc(payCommand(env, "<amount>", a.deposit_code))}</div>
      </div>`
    )
    .join("");

  const body = `<section>
    <h1>Deposit</h1>
    <p class="muted">Money is credited automatically, usually within a minute of paying.</p>
    ${blocks || `<div class="empty">No accounts yet.</div>`}
    <div class="card" style="margin-top:16px">
      <form method="POST" action="/app/deposit/check">
        <button class="btn" type="submit">I have paid, check now</button>
      </form>
      <p class="muted small" style="margin-top:10px;margin-bottom:0">Deposits are credited
      automatically. This just checks straight away instead of waiting.</p>
    </div>
    ${notice(
      `Include the code in the memo exactly. If you forget it, the payment still reaches us -
       it just has to be matched by hand, which is slower.`
    )}
  </section>`;
  return html(layout("Deposit", body, { user, active: "deposit" }));
}

// ---------------------------------------------------------------------------
// withdraw
// ---------------------------------------------------------------------------
export async function pageWithdraw(env, db, user, message = "") {
  if (!auth.isVerified(user)) {
    const body = `<section>
      <h1>Withdraw</h1>
      ${notice(
        `<b>Verify your Minecraft account first.</b> A withdrawal sends real money to a
         Minecraft player, so we need proof you control that account before we'll send it
         anywhere. <a href="/app/verify">Verify now →</a>`,
        "warn"
      )}
    </section>`;
    return html(layout("Withdraw", body, { user, active: "withdraw" }));
  }

  const accounts = (await ledger.listUserAccounts(db, user.id)).filter((a) => a.status === "active");
  const paused = (await ledger.getSetting(db, "withdrawals_paused", "0")) === "1";

  const options = accounts
    .map((a) => `<option value="${a.id}">${esc(a.label || a.kind)} - ${money(a.balance_cents)}</option>`)
    .join("");

  const recent = accounts.length ? await withdrawals.listForAccount(db, accounts[0].id, 8) : [];
  const recentRows = recent
    .map(
      (w) => `<tr><td class="muted small">${shortDate(w.created_at)}</td>
        <td class="num">${money(w.amount_cents)}</td>
        <td><span class="pill ${
          w.status === "sent" ? "good" : w.status === "failed" ? "bad" : "warn"
        }">${esc(w.status.replace("_", " "))}</span></td></tr>`
    )
    .join("");

  const body = `<section>
    <h1>Withdraw</h1>
    <p class="muted">Sent to <b>${esc(user.mc_username)}</b> in game, usually instantly.</p>
    ${message}
    ${paused ? notice(`<b>Withdrawals are paused</b> while staff check something. Your balance is safe and unaffected.`, "warn") : ""}
    <div class="card" style="margin-top:16px">
      <form method="POST" action="/app/withdraw">
        <div class="field"><label>From</label><select name="account_id" required>${options}</select></div>
        <div class="field"><label>Amount</label><input name="amount" placeholder="0.00" inputmode="decimal" required></div>
        <button class="btn" type="submit" ${paused ? "disabled" : ""}>Withdraw</button>
      </form>
    </div>
    ${
      recentRows
        ? `<div class="card" style="margin-top:16px"><h3>Recent withdrawals</h3>
           <table><tbody>${recentRows}</tbody></table></div>`
        : ""
    }
  </section>`;
  return html(layout("Withdraw", body, { user, active: "withdraw" }));
}

export async function doWithdraw(env, db, user, request) {
  const form = await request.formData();
  const accountId = parseInt(form.get("account_id"), 10);
  const parsed = parseUserAmount(form.get("amount"), { min: 1 });

  if (parsed.error) return await pageWithdraw(env, db, user, notice(esc(parsed.error), "bad"));
  if (!Number.isFinite(accountId)) return await pageWithdraw(env, db, user, notice("Pick an account.", "bad"));

  try {
    const res = await withdrawals.requestWithdrawal(env, db, {
      accountId,
      userId: user.id,
      amountCents: parsed.cents,
    });

    if (res.status === "sent") {
      return await pageWithdraw(
        env, db, user,
        notice(`<b>Sent.</b> ${money(parsed.cents)} is on its way to ${esc(user.mc_username)}.`, "good")
      );
    }
    // pending / needs_review - money has left their balance but we can't yet
    // confirm it arrived. Say so plainly rather than implying success.
    return await pageWithdraw(
      env, db, user,
      notice(
        `<b>Processing.</b> We've reserved ${money(parsed.cents)} and are confirming the transfer.
         If it doesn't arrive shortly it will be returned to your balance automatically -
         it will not be sent twice.`,
        "warn"
      )
    );
  } catch (err) {
    return await pageWithdraw(env, db, user, notice(esc(err.message), "bad"));
  }
}

// ---------------------------------------------------------------------------
// transfer - internal, instant, no Treasury round-trip
// ---------------------------------------------------------------------------
export async function pageTransfer(env, db, user, message = "") {
  const accounts = (await ledger.listUserAccounts(db, user.id)).filter((a) => a.status === "active");
  const options = accounts
    .map((a) => `<option value="${a.id}">${esc(a.label || a.kind)} - ${money(a.balance_cents)}</option>`)
    .join("");

  const body = `<section>
    <h1>Transfer</h1>
    <p class="muted">Instant and free between Z&amp;E Bank customers - the money never leaves the bank.</p>
    ${message}
    <div class="card" style="margin-top:16px">
      <form method="POST" action="/app/transfer">
        <div class="field"><label>From</label><select name="from_id" required>${options}</select></div>
        <div class="field"><label>To (Minecraft username)</label>
          <input name="to" placeholder="e.g. Steve" required maxlength="16"></div>
        <div class="field"><label>Amount</label><input name="amount" placeholder="0.00" inputmode="decimal" required></div>
        <div class="field"><label>Reference (optional)</label><input name="memo" maxlength="80"></div>
        <button class="btn" type="submit">Send</button>
      </form>
    </div>
    ${notice(`The recipient must already be a Z&amp;E Bank customer with a verified Minecraft account.`)}
  </section>`;
  return html(layout("Transfer", body, { user, active: "transfer" }));
}

export async function doTransfer(env, db, user, request) {
  const form = await request.formData();
  const fromId = parseInt(form.get("from_id"), 10);
  const toName = String(form.get("to") || "").trim();
  const memo = String(form.get("memo") || "").trim().slice(0, 80) || null;
  const parsed = parseUserAmount(form.get("amount"), { min: 1 });

  if (parsed.error) return await pageTransfer(env, db, user, notice(esc(parsed.error), "bad"));

  const target = await db
    .prepare(
      `SELECT * FROM users WHERE LOWER(mc_username) = LOWER(?) AND mc_verified_at IS NOT NULL AND status='active'`
    )
    .bind(toName)
    .first();
  if (!target) {
    return await pageTransfer(env, db, user, notice(`No verified Z&amp;E Bank customer called “${esc(toName)}”.`, "bad"));
  }
  if (target.id === user.id) {
    return await pageTransfer(env, db, user, notice("That's you.", "bad"));
  }

  const toAccount = await ledger.defaultAccountForUser(db, target.id);
  if (!toAccount) {
    return await pageTransfer(env, db, user, notice("That customer has no account to receive into.", "bad"));
  }

  try {
    await ledger.transferInternal(db, {
      fromAccountId: fromId,
      toAccountId: toAccount.id,
      amountCents: parsed.cents,
      memo: memo || `Transfer to ${target.mc_username}`,
      byUserId: user.id,
    });
    return await pageTransfer(
      env, db, user,
      notice(`<b>Sent.</b> ${money(parsed.cents)} to ${esc(target.mc_username)}.`, "good")
    );
  } catch (err) {
    return await pageTransfer(env, db, user, notice(esc(err.message), "bad"));
  }
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------
export async function pageVerify(env, db, user, message = "") {
  if (auth.isVerified(user)) {
    const body = `<section><h1>Minecraft account</h1>
      ${notice(`<b>Verified</b> as ${esc(user.mc_username)}. Withdrawals are enabled.`, "good")}
      <a class="btn ghost" href="/app">Back to accounts</a></section>`;
    return html(layout("Verify", body, { user }));
  }

  const pending = await auth.pendingVerification(db, user.id);
  const pendingBlock = pending
    ? `<div class="card" style="margin-top:16px">
        <h3>Waiting for your payment</h3>
        <p class="muted small">Send exactly ${money(pending.amount_cents)} from
        <b>${esc(pending.mc_username)}</b> with this memo. The money is credited to your
        account - it isn't a fee.</p>
        <div class="code">${esc(payCommand(env, (pending.amount_cents / 100).toFixed(2), pending.code))}</div>
        <p class="muted small" style="margin-top:12px">It must come from that account -
        that is what proves it is yours.</p>
        <form method="POST" action="/app/verify/check" style="margin-top:12px">
          <button class="btn" type="submit">I have paid, check now</button>
        </form>
        <p class="muted small" style="margin-top:10px;margin-bottom:0">Payments are also picked
        up automatically, so you can close this page and come back.</p>
      </div>`
    : "";

  const body = `<section>
    <h1>Verify your Minecraft account</h1>
    <p class="muted">Required before withdrawing, so money can't be sent to an account you don't control.</p>
    ${message}
    ${pendingBlock}
    <div class="card" style="margin-top:16px">
      <form method="POST" action="/app/verify">
        <div class="field"><label>Minecraft username</label>
          <input name="mc" placeholder="e.g. Steve" required maxlength="16"></div>
        <button class="btn" type="submit">${pending ? "Start again with a different name" : "Get my code"}</button>
      </form>
    </div>
  </section>`;
  return html(layout("Verify", body, { user }));
}

export async function doVerify(env, db, user, request) {
  const form = await request.formData();
  try {
    await auth.startVerification(env, db, user, form.get("mc"));
    return redirect("/app/verify");
  } catch (err) {
    return await pageVerify(env, db, user, notice(esc(err.message), "bad"));
  }
}

/** Set or clear a low balance alert. Display only, no money involved. */
export async function doSetAlert(env, db, user, request) {
  const form = await request.formData();
  const accountId = parseInt(form.get("account_id"), 10);
  const raw = String(form.get("below") || "").trim();

  const account = await ledger.getAccount(db, accountId);
  if (!account || account.owner_user_id !== user.id) return redirect("/app");

  let cents = null;
  if (raw) {
    const parsed = parseUserAmount(raw, { min: 1 });
    if (!parsed.error) cents = parsed.cents;
  }

  await db
    .prepare(`UPDATE accounts SET alert_below_cents = ? WHERE id = ?`)
    .bind(cents, accountId)
    .run();

  return redirect(`/app/account/${accountId}`);
}

/**
 * "I have paid, check now."
 *
 * Deposits arrive automatically, but automatically means within 5 minutes if
 * the webhook is not registered, and even with a webhook there is a moment
 * where the customer is staring at a page wondering whether it worked. This
 * lets them pull the Treasury themselves.
 *
 * Rate limited by the caller, because every press costs a Treasury API call
 * and those are capped per minute for the whole bank, not per user.
 */
export async function doCheckNow(env, db, user, request, backTo = "/app") {
  try {
    await deposits.ingestFeed(env, db, { maxPages: 2 });
  } catch {
    // A failed check is not worth an error page. Whatever they paid is still
    // in the Treasury and the cron will find it.
  }
  return redirect(backTo);
}
