// businessui.js - company pages.
//   /app/business            list and create
//   /app/business/:id        overview, members, money
//   /app/business/:id/tier   choose a plan
//   /company/:firmName       public profile (Platinum only)

import * as ledger from "./ledger.js";
import * as biz from "./business.js";
import { parseUserAmount } from "./money.js";
import { esc, html, layout, money, signedMoney, shortDate, notice, redirect } from "./views.js";

const PAY_TO = (env) => env.BANK_FIRM_NAME || "ZEBank";

// Logos are stored as base64 in the database, so they must be small and must
// not be SVG. An SVG can carry script and this string goes straight into an
// img src.
const MAX_LOGO_BYTES = 400_000;
const LOGO_PREFIXES = [
  "data:image/jpeg;base64,",
  "data:image/jpg;base64,",
  "data:image/png;base64,",
  "data:image/webp;base64,",
];
function validateLogo(v) {
  if (!v || typeof v !== "string") return null;
  if (!LOGO_PREFIXES.some((p) => v.startsWith(p))) return null;
  if (v.length > MAX_LOGO_BYTES) return null;
  return v;
}

// Shrinks the chosen file in the browser before upload, so a 3MB screenshot
// does not get rejected for being large.
const LOGO_SCRIPT = `<script>
function __logo(input){
  var f = input.files[0]; if(!f) return;
  if(!/^image\\//.test(f.type)){ alert("That is not an image."); return; }
  var r = new FileReader();
  r.onload = function(){
    var img = new Image();
    img.onload = function(){
      var max = 256, w = img.width, h = img.height;
      if (w > h && w > max) { h = Math.round(h*max/w); w = max; }
      else if (h > max) { w = Math.round(w*max/h); h = max; }
      var c = document.createElement("canvas"); c.width=w; c.height=h;
      c.getContext("2d").drawImage(img,0,0,w,h);
      var q=0.85, out=c.toDataURL("image/png");
      if(out.length > 380000) out = c.toDataURL("image/jpeg", q);
      while(out.length > 380000 && q > 0.3){ q -= 0.15; out = c.toDataURL("image/jpeg", q); }
      if(out.length > 395000){ alert("That image is too large even after shrinking."); return; }
      document.getElementById("logo_data").value = out;
      var p = document.getElementById("logo_preview");
      p.src = out; p.style.display = "block";
    };
    img.src = r.result;
  };
  r.readAsDataURL(f);
}
</script>`;

// ---------------------------------------------------------------------------
// list + create
// ---------------------------------------------------------------------------
export async function pageBusinessList(env, db, user, message = "") {
  const list = await biz.businessesForUser(db, user.id);

  const rows = await Promise.all(
    list.map(async (b) => {
      const acct = await biz.businessAccount(db, b.id);
      const tier = biz.tierOf(b);
      const active = biz.perksActive(b);
      return `<div class="acct-row">
        <div>
          <div style="font-weight:600">${esc(b.display_name)}</div>
          <div class="muted small">${esc(b.firm_name)} · ${esc(tier.name)}
            ${active ? "" : `<span class="pill warn">unpaid</span>`}
            ${b.status === "overdue" ? `<span class="pill bad">overdue</span>` : ""}
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-weight:700">${money(acct ? acct.balance_cents : 0)}</div>
          <a class="small muted" href="/app/business/${b.id}">Manage</a>
        </div>
      </div>`;
    })
  );

  const body = `<section>
    <h1>Companies</h1>
    <p class="muted">Business accounts for firms you own or work for.</p>
    ${message}
    <div class="card" style="margin-top:16px">
      <h2>Your companies</h2>
      ${rows.join("") || `<p class="muted">You are not part of any company yet.</p>`}
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Register a company</h3>
      <p class="muted small">The firm must already exist in game. We check the name against
      the server, but we cannot verify who owns a firm, so registering a company you do not
      own will be reversed by staff.</p>
      <form method="POST" action="/app/business">
        <div class="field"><label>Firm name, exactly as in game</label>
          <input name="firm_name" required maxlength="40" placeholder="e.g. Z&amp;E"></div>
        <div class="field"><label>Display name (optional)</label>
          <input name="display_name" maxlength="60"></div>
        <button class="btn" type="submit">Register company</button>
      </form>
    </div>
  </section>`;
  return html(layout("Companies", body, { user, active: "business" }));
}

export async function doCreateBusiness(env, db, user, request) {
  const form = await request.formData();
  try {
    const { businessId } = await biz.createBusiness(env, db, user, {
      firmName: form.get("firm_name"),
      displayName: form.get("display_name"),
    });
    return redirect(`/app/business/${businessId}`);
  } catch (err) {
    return await pageBusinessList(env, db, user, notice(esc(err.message), "bad"));
  }
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------
export async function pageBusiness(env, db, user, businessId, message = "") {
  const b = await biz.getBusiness(db, businessId);
  if (!b) return html(layout("Not found", `<section><h1>Company not found</h1></section>`, { user }), 404);

  const role = await biz.roleFor(db, businessId, user.id);
  if (!role) {
    return html(
      layout("Not allowed", `<section><h1>Not your company</h1>
        <p class="muted">You are not a member of this company.</p>
        <a class="btn ghost" href="/app/business">Back</a></section>`, { user }),
      403
    );
  }

  const [account, memberList, charges] = await Promise.all([
    biz.businessAccount(db, businessId),
    biz.members(db, businessId),
    biz.chargeHistory(db, businessId, 6),
  ]);

  const tier = biz.tierOf(b);
  const effective = biz.effectiveTier(b);
  const active = biz.perksActive(b);
  const isOwner = biz.canAdminister(role);
  const canMoney = biz.canManageMoney(role);

  const statusNotice = !active
    ? notice(
        `<b>${esc(tier.name)} perks are not active.</b> ${
          b.status === "overdue"
            ? "The last tier payment could not be taken because the account was short."
            : "This company has not been billed yet."
        } Limits currently follow Silver. Top the account up and it will be charged on the next billing run.`,
        "warn"
      )
    : "";

  const memberRows = memberList
    .map(
      (m) => `<div class="acct-row">
        <div>
          <div style="font-weight:600">${esc(m.mc_username || m.discord_username || "unknown")}</div>
          <div class="muted small">${esc(m.discord_username || "")} · ${esc(m.role)}</div>
        </div>
        <div style="text-align:right">
          ${
            isOwner && m.role !== "owner"
              ? `<form method="POST" action="/app/business/${businessId}/members">
                   <input type="hidden" name="action" value="remove">
                   <input type="hidden" name="user_id" value="${m.user_id}">
                   <button class="btn ghost sm" type="submit">Remove</button>
                 </form>`
              : `<span class="pill">${esc(m.role)}</span>`
          }
        </div>
      </div>`
    )
    .join("");

  const employeeCount = memberList.filter((m) => m.role !== "owner").length;
  const capLabel = effective.maxEmployees === Infinity ? "unlimited" : effective.maxEmployees;

  const chargeRows = charges
    .map(
      (c) => `<tr><td>${esc(c.period)}</td><td>${esc(c.tier)}</td>
        <td class="num">${money(c.amount_cents)}</td>
        <td><span class="pill ${c.status === "paid" ? "good" : "bad"}">${esc(c.status)}</span></td></tr>`
    )
    .join("");

  const body = `<section>
    <a class="muted small" href="/app/business">Back to companies</a>
    <div style="display:flex;align-items:center;gap:14px;margin-top:10px">
      ${
        b.logo_url
          ? `<img src="${esc(b.logo_url)}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:10px">`
          : ""
      }
      <div>
        <h1 style="margin:0">${esc(b.display_name)}</h1>
        <p class="muted" style="margin:0">${esc(b.firm_name)} · ${esc(tier.name)}
          ${active ? `<span class="pill good">active</span>` : `<span class="pill warn">inactive</span>`}</p>
      </div>
    </div>
    ${message}${statusNotice}

    <div class="card" style="margin-top:16px">
      <div class="muted small">Company balance</div>
      <div class="balance">${money(account ? account.balance_cents : 0)}</div>
      ${
        account && account.deposit_code
          ? `<p class="muted small" style="margin-top:10px;margin-bottom:6px">Pay this in game to fund the company:</p>
             <div class="code">/pay ${esc(PAY_TO(env))} &lt;amount&gt; ${esc(account.deposit_code)}</div>`
          : ""
      }
      ${
        canMoney && account
          ? `<div style="margin-top:16px">
               <a class="btn ghost sm" href="/app/account/${account.id}">Statement</a>
             </div>`
          : ""
      }
    </div>

    ${
      canMoney
        ? `<div class="card" style="margin-top:16px">
            <h3>Pay someone</h3>
            <p class="muted small">Instant transfer from the company account to any verified customer.</p>
            <form method="POST" action="/app/business/${businessId}/pay">
              <div class="field"><label>To (Minecraft username)</label>
                <input name="to" required maxlength="16"></div>
              <div class="field"><label>Amount</label>
                <input name="amount" placeholder="0.00" inputmode="decimal" required></div>
              <div class="field"><label>Reference</label><input name="memo" maxlength="80"></div>
              <button class="btn" type="submit">Send</button>
            </form>
          </div>`
        : ""
    }

    <div class="card" style="margin-top:16px">
      <h3>People (${employeeCount} of ${capLabel})</h3>
      ${memberRows}
      ${
        isOwner
          ? `<form method="POST" action="/app/business/${businessId}/members" style="margin-top:14px">
               <input type="hidden" name="action" value="add">
               <div class="field"><label>Add by Minecraft username</label>
                 <input name="mc" required maxlength="16"></div>
               <div class="field"><label>Role</label>
                 <select name="role">
                   <option value="employee">Employee, appears on payroll only</option>
                   <option value="manager">Manager, can move company money</option>
                 </select></div>
               <button class="btn ghost" type="submit">Add person</button>
             </form>
             <p class="muted small">They must already be a Z&amp;E Bank customer with a verified
             Minecraft account. This list is ours, not your in game firm roster, because the
             server does not let us read another firm's employees.</p>`
          : ""
      }
    </div>

    ${
      isOwner
        ? `<div class="card" style="margin-top:16px">
            <h3>Plan</h3>
            <p class="muted small">Currently ${esc(tier.name)} at ${money(
              (tier.monthly * 100) | 0
            )} a month.</p>
            <a class="btn ghost" href="/app/business/${businessId}/tier">Change plan</a>
          </div>

          ${
            biz.effectiveTier(b).logo
              ? `<div class="card" style="margin-top:16px">
                  <h3>Company logo</h3>
                  <form method="POST" action="/app/business/${businessId}/logo">
                    <input type="file" accept="image/*" onchange="__logo(this)">
                    <input type="hidden" id="logo_data" name="logo">
                    <img id="logo_preview" src="${esc(b.logo_url || "")}" style="display:${
                  b.logo_url ? "block" : "none"
                };margin-top:12px;width:96px;height:96px;object-fit:cover;border-radius:10px">
                    <div style="margin-top:12px">
                      <button class="btn ghost sm" type="submit">Save logo</button>
                    </div>
                  </form>
                </div>${LOGO_SCRIPT}`
              : ""
          }

          ${
            biz.effectiveTier(b).publicProfile
              ? `<div class="card" style="margin-top:16px">
                  <h3>Public profile</h3>
                  <p class="muted small">Platinum companies get a public page at
                  <a href="/company/${encodeURIComponent(b.firm_name)}">/company/${esc(b.firm_name)}</a></p>
                  <form method="POST" action="/app/business/${businessId}/profile">
                    <div class="field"><label>Description shown publicly</label>
                      <input name="description" maxlength="300" value="${esc(b.description || "")}"></div>
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
                      <input type="checkbox" name="public" value="1" ${b.public_profile ? "checked" : ""}
                        style="width:auto">
                      <span>Show this company publicly</span></label>
                    <button class="btn ghost sm" type="submit">Save</button>
                  </form>
                </div>`
              : ""
          }

          <div class="card" style="margin-top:16px">
            <h3>Billing history</h3>
            <table><thead><tr><th>Month</th><th>Plan</th>
              <th style="text-align:right">Amount</th><th>Status</th></tr></thead>
            <tbody>${chargeRows || `<tr><td colspan="4" class="muted">Not billed yet.</td></tr>`}</tbody></table>
          </div>`
        : ""
    }
  </section>`;
  return html(layout(b.display_name, body, { user, active: "business" }));
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
async function requireRole(db, user, businessId, needOwner = false) {
  const b = await biz.getBusiness(db, businessId);
  if (!b) throw new Error("Company not found.");
  const role = await biz.roleFor(db, businessId, user.id);
  if (!role) throw new Error("You are not a member of this company.");
  if (needOwner && !biz.canAdminister(role)) throw new Error("Only the owner can do that.");
  return { b, role };
}

export async function doMemberAction(env, db, user, businessId, request) {
  const form = await request.formData();
  try {
    const { b } = await requireRole(db, user, businessId, true);
    if (String(form.get("action")) === "add") {
      await biz.addMember(db, b, user, { mcUsername: form.get("mc"), role: String(form.get("role")) });
      return await pageBusiness(env, db, user, businessId, notice("Added.", "good"));
    }
    await biz.removeMember(db, b, user, parseInt(form.get("user_id"), 10));
    return await pageBusiness(env, db, user, businessId, notice("Removed.", "good"));
  } catch (err) {
    return await pageBusiness(env, db, user, businessId, notice(esc(err.message), "bad"));
  }
}

export async function pageTier(env, db, user, businessId, message = "") {
  const { b } = await requireRole(db, user, businessId, true).catch(() => ({ b: null }));
  if (!b) return redirect("/app/business");

  const cards = Object.values(biz.TIERS)
    .map((t) => {
      const current = t.key === b.tier;
      return `<div class="card" style="${current ? "border-color:var(--accent)" : ""}">
        <h3>${esc(t.name)}</h3>
        <div class="balance" style="font-size:24px">${money(t.monthly * 100)}</div>
        <div class="muted small">per month</div>
        <ul class="muted small" style="padding-left:18px;margin-top:12px">
          ${t.perks.map((p) => `<li>${esc(p)}</li>`).join("")}
        </ul>
        ${
          current
            ? `<span class="pill good">Current plan</span>`
            : `<form method="POST" action="/app/business/${businessId}/tier">
                 <input type="hidden" name="tier" value="${t.key}">
                 <button class="btn" type="submit">Switch to ${esc(t.name)}</button>
               </form>`
        }
      </div>`;
    })
    .join("");

  const body = `<section>
    <a class="muted small" href="/app/business/${businessId}">Back to company</a>
    <h1 style="margin-top:10px">Choose a plan</h1>
    <p class="muted">Changes apply immediately. You are charged once a month, at the start of
    the month, from the company account.</p>
    ${message}
    <div class="cards c3" style="margin-top:18px">${cards}</div>
    <p class="muted small" style="margin-top:16px">Loan rate discounts are included in Gold and
    Platinum and will apply once lending launches.</p>
  </section>`;
  return html(layout("Plans", body, { user, active: "business" }));
}

export async function doSetTier(env, db, user, businessId, request) {
  const form = await request.formData();
  try {
    const { b } = await requireRole(db, user, businessId, true);
    await biz.setTier(db, b, user, String(form.get("tier")));
    return await pageTier(env, db, user, businessId, notice("Plan updated.", "good"));
  } catch (err) {
    return await pageTier(env, db, user, businessId, notice(esc(err.message), "bad"));
  }
}

export async function doBusinessPay(env, db, user, businessId, request) {
  const form = await request.formData();
  try {
    const { role } = await requireRole(db, user, businessId);
    if (!biz.canManageMoney(role)) throw new Error("You cannot move this company's money.");

    const account = await biz.businessAccount(db, businessId);
    if (!account) throw new Error("This company has no account.");

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

    await ledger.transferInternal(db, {
      fromAccountId: account.id,
      toAccountId: toAccount.id,
      amountCents: parsed.cents,
      memo: String(form.get("memo") || "").slice(0, 80) || `Payment from ${account.label}`,
      byUserId: user.id,
    });

    return await pageBusiness(
      env, db, user, businessId,
      notice(`Sent ${money(parsed.cents)} to ${esc(target.mc_username)}.`, "good")
    );
  } catch (err) {
    return await pageBusiness(env, db, user, businessId, notice(esc(err.message), "bad"));
  }
}

export async function doLogo(env, db, user, businessId, request) {
  const form = await request.formData();
  try {
    const { b } = await requireRole(db, user, businessId, true);
    if (!biz.effectiveTier(b).logo) throw new Error("Custom logos are a Gold and Platinum feature.");

    const logo = validateLogo(String(form.get("logo") || ""));
    if (!logo) throw new Error("Logo must be a PNG, JPEG or WebP under 400 KB.");

    await db.prepare(`UPDATE businesses SET logo_url = ? WHERE id = ?`).bind(logo, businessId).run();
    return await pageBusiness(env, db, user, businessId, notice("Logo saved.", "good"));
  } catch (err) {
    return await pageBusiness(env, db, user, businessId, notice(esc(err.message), "bad"));
  }
}

export async function doProfile(env, db, user, businessId, request) {
  const form = await request.formData();
  try {
    const { b } = await requireRole(db, user, businessId, true);
    if (!biz.effectiveTier(b).publicProfile) throw new Error("Public profiles are a Platinum feature.");

    await db
      .prepare(`UPDATE businesses SET description = ?, public_profile = ? WHERE id = ?`)
      .bind(String(form.get("description") || "").slice(0, 300), form.get("public") ? 1 : 0, businessId)
      .run();
    return await pageBusiness(env, db, user, businessId, notice("Profile saved.", "good"));
  } catch (err) {
    return await pageBusiness(env, db, user, businessId, notice(esc(err.message), "bad"));
  }
}

// ---------------------------------------------------------------------------
// public profile
// ---------------------------------------------------------------------------
export async function pageCompanyProfile(env, db, user, firmName) {
  const b = await biz.getBusinessByFirm(db, firmName);

  // Gated on the EFFECTIVE tier, so a lapsed Platinum profile goes private
  // rather than staying up unpaid.
  if (!b || !b.public_profile || !biz.effectiveTier(b).publicProfile) {
    return html(
      layout("Not found", `<section><h1>No public profile</h1>
        <p class="muted">This company does not have a public page.</p>
        <a class="btn ghost" href="/">Home</a></section>`, { user }),
      404
    );
  }

  const memberCount = await db
    .prepare(`SELECT COUNT(*) AS n FROM business_members WHERE business_id = ?`)
    .bind(b.id)
    .first();

  const body = `<section style="padding-top:48px">
    <div style="display:flex;align-items:center;gap:18px">
      ${
        b.logo_url
          ? `<img src="${esc(b.logo_url)}" alt="" style="width:80px;height:80px;object-fit:cover;border-radius:14px">`
          : ""
      }
      <div>
        <h1 style="margin:0">${esc(b.display_name)}</h1>
        <p class="muted" style="margin:0">${esc(b.firm_name)} · banking with Z&amp;E Bank since
        ${shortDate(b.created_at).slice(0, 10)}</p>
      </div>
    </div>
    ${b.description ? `<p style="margin-top:20px;max-width:60ch">${esc(b.description)}</p>` : ""}
    <div class="cards c3" style="margin-top:24px">
      <div class="card"><div class="muted small">Team</div>
        <div class="balance" style="font-size:24px">${memberCount ? memberCount.n : 0}</div></div>
      <div class="card"><div class="muted small">Plan</div>
        <div class="balance" style="font-size:24px">${esc(biz.tierOf(b).name)}</div></div>
      <div class="card"><div class="muted small">Verified firm</div>
        <div class="balance" style="font-size:24px">Yes</div></div>
    </div>
    <p class="muted small" style="margin-top:24px">Balances are never shown publicly.</p>
  </section>`;
  return html(layout(b.display_name, body, { user }));
}
