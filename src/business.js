// business.js - business accounts and the three tiers.
// ===========================================================================
// A business is a DemocracyCraft firm with a bank account, a member list, and
// a paid tier. The tier controls limits (employees, direct debits) and perks
// (rate bonuses, logo, public profile).
//
// TWO THINGS TO KNOW BEFORE READING FURTHER:
//
// 1. Members are OURS, not DemocracyCraft's.
//    The Treasury API only exposes the employee roster of the firm its own key
//    belongs to. We cannot read another firm's employees, so owners manage the
//    list here. The firm NAME is verified against the Treasury, so nobody can
//    claim a firm that does not exist, but the roster is independent.
//
// 2. Billing cannot double charge.
//    UNIQUE(business_id, period) plus a deterministic entry idempotency key,
//    the same belt and braces used for interest. Run the billing job as often
//    as you like.
// ===========================================================================

import * as ledger from "./ledger.js";
import * as treasury from "./treasury.js";
import { toCents } from "./money.js";

// ---------------------------------------------------------------------------
// Tier definitions. Prices are in whole currency, converted to cents on use.
//
// cdBonusBps and loanDiscountBps are stored here so the products can read them
// when those products exist. Loans do not exist yet, so the loan discount is
// deliberately not advertised as live anywhere in the UI.
// ---------------------------------------------------------------------------
export const TIERS = {
  silver: {
    key: "silver",
    name: "Silver",
    monthly: 1000,
    maxEmployees: 5,
    maxDirectDebits: 3,
    cdBonusBps: 0,
    loanDiscountBps: 0,
    multiSigners: 1,
    logo: false,
    publicProfile: false,
    webhooks: false,
    perks: ["Business account", "Up to 5 employees", "Up to 3 direct debits"],
  },
  gold: {
    key: "gold",
    name: "Gold",
    monthly: 3000,
    maxEmployees: 20,
    maxDirectDebits: 10,
    cdBonusBps: 50,
    loanDiscountBps: 50,
    multiSigners: 1,
    logo: true,
    publicProfile: false,
    webhooks: false,
    perks: [
      "Up to 20 employees",
      "Up to 10 direct debits",
      "+0.50% on fixed deposits",
      "Custom company logo",
      "Priority support",
    ],
  },
  platinum: {
    key: "platinum",
    name: "Platinum",
    monthly: 6000,
    maxEmployees: Infinity,
    maxDirectDebits: Infinity,
    cdBonusBps: 100,
    loanDiscountBps: 150,
    multiSigners: 3,
    logo: true,
    publicProfile: true,
    webhooks: true,
    perks: [
      "Unlimited employees",
      "Unlimited direct debits",
      "+1.00% on fixed deposits",
      "Custom company logo",
      "Public company profile",
      "Multi signer approval, up to 3",
      "Dedicated admin support",
      "Webhook integration",
    ],
  },
};

export const tierOf = (business) => TIERS[business?.tier] || TIERS.silver;

/** Tier perks only apply while the subscription is paid up. */
export function perksActive(business) {
  if (!business) return false;
  if (business.status !== "active") return false;
  if (!business.paid_until) return false;
  return new Date(business.paid_until + "Z") > new Date();
}

/** Effective tier: an unpaid business falls back to silver limits. */
export function effectiveTier(business) {
  return perksActive(business) ? tierOf(business) : TIERS.silver;
}

// ---------------------------------------------------------------------------
// creation
// ---------------------------------------------------------------------------
/**
 * Create a business. The firm name is checked against the Treasury so a
 * business cannot be registered against a firm that does not exist.
 *
 * Note this does NOT prove the user owns that firm. The Treasury gives us no
 * way to verify that for a firm other than our own, so ownership is asserted
 * and can be disputed to an admin. That limitation is stated in the UI rather
 * than hidden.
 */
export async function createBusiness(env, db, user, { firmName, displayName, description = null }) {
  const name = String(firmName || "").trim();
  if (name.length < 2 || name.length > 40) throw new Error("Enter the firm name as it appears in game.");

  const existing = await db
    .prepare(`SELECT id FROM businesses WHERE LOWER(firm_name) = LOWER(?)`)
    .bind(name)
    .first();
  if (existing) throw new Error("That firm is already registered with Z&E Bank.");

  let firm = null;
  try {
    firm = await treasury.publicFirm(env, name);
  } catch {
    firm = null;
  }
  if (!firm) throw new Error(`No DemocracyCraft firm called "${name}" was found.`);

  const ins = await db
    .prepare(
      `INSERT INTO businesses (firm_name, display_name, owner_user_id, description, tier)
       VALUES (?, ?, ?, ?, 'silver')`
    )
    .bind(firm.displayName || name, String(displayName || firm.displayName || name).slice(0, 60), user.id, description)
    .run();
  const businessId = ins.meta.last_row_id;

  await db
    .prepare(`INSERT INTO business_members (business_id, user_id, role, added_by) VALUES (?, ?, 'owner', ?)`)
    .bind(businessId, user.id, user.id)
    .run();

  // The business account is an ordinary checking account carrying
  // owner_business_id. See migration 003 for why it is not its own kind.
  const accountId = await ledger.openAccount(db, {
    userId: user.id,
    kind: "checking",
    label: `${firm.displayName || name} business account`,
  });
  await db
    .prepare(`UPDATE accounts SET owner_business_id = ? WHERE id = ?`)
    .bind(businessId, accountId)
    .run();

  await ledger.audit(db, {
    actorId: user.id,
    action: "business.created",
    targetType: "business",
    targetId: businessId,
    detail: name,
  });

  return { businessId, accountId };
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------
export async function getBusiness(db, id) {
  return await db.prepare(`SELECT * FROM businesses WHERE id = ?`).bind(id).first();
}

export async function getBusinessByFirm(db, firmName) {
  return await db
    .prepare(`SELECT * FROM businesses WHERE LOWER(firm_name) = LOWER(?)`)
    .bind(String(firmName || ""))
    .first();
}

export async function businessAccount(db, businessId) {
  return await db
    .prepare(`SELECT * FROM accounts WHERE owner_business_id = ? ORDER BY id LIMIT 1`)
    .bind(businessId)
    .first();
}

/** Businesses this user belongs to, with their role. */
export async function businessesForUser(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT b.*, m.role AS my_role
         FROM businesses b
         JOIN business_members m ON m.business_id = b.id
        WHERE m.user_id = ? AND b.status <> 'closed'
        ORDER BY b.id`
    )
    .bind(userId)
    .all();
  return results;
}

export async function members(db, businessId) {
  const { results } = await db
    .prepare(
      `SELECT m.*, u.discord_username, u.mc_username, u.mc_verified_at
         FROM business_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.business_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, m.id`
    )
    .bind(businessId)
    .all();
  return results;
}

export async function roleFor(db, businessId, userId) {
  const r = await db
    .prepare(`SELECT role FROM business_members WHERE business_id = ? AND user_id = ?`)
    .bind(businessId, userId)
    .first();
  return r ? r.role : null;
}

export const canManageMoney = (role) => role === "owner" || role === "manager";
export const canAdminister = (role) => role === "owner";

// ---------------------------------------------------------------------------
// members
// ---------------------------------------------------------------------------
export async function addMember(db, business, actor, { mcUsername, role = "employee" }) {
  if (!["manager", "employee"].includes(role)) throw new Error("Pick a valid role.");

  const target = await db
    .prepare(
      `SELECT * FROM users
        WHERE LOWER(mc_username) = LOWER(?) AND mc_verified_at IS NOT NULL AND status = 'active'`
    )
    .bind(String(mcUsername || "").trim())
    .first();
  if (!target) throw new Error("No verified Z&E Bank customer with that Minecraft name.");

  const already = await roleFor(db, business.id, target.id);
  if (already) throw new Error("They are already a member.");

  // Employee cap comes from the EFFECTIVE tier, so a business that stops
  // paying cannot keep adding people on perks it is no longer buying.
  const tier = effectiveTier(business);
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM business_members WHERE business_id = ? AND role <> 'owner'`)
    .bind(business.id)
    .first();
  if (countRow && countRow.n >= tier.maxEmployees) {
    throw new Error(
      `${tier.name} allows ${tier.maxEmployees} employees. Upgrade the tier to add more.`
    );
  }

  await db
    .prepare(`INSERT INTO business_members (business_id, user_id, role, added_by) VALUES (?, ?, ?, ?)`)
    .bind(business.id, target.id, role, actor.id)
    .run();

  await ledger.audit(db, {
    actorId: actor.id,
    action: "business.member_added",
    targetType: "business",
    targetId: business.id,
    detail: `${target.mc_username} as ${role}`,
  });
}

export async function removeMember(db, business, actor, userId) {
  const role = await roleFor(db, business.id, userId);
  if (!role) throw new Error("They are not a member.");
  if (role === "owner") throw new Error("The owner cannot be removed.");

  await db
    .prepare(`DELETE FROM business_members WHERE business_id = ? AND user_id = ?`)
    .bind(business.id, userId)
    .run();

  await ledger.audit(db, {
    actorId: actor.id,
    action: "business.member_removed",
    targetType: "business",
    targetId: business.id,
    detail: String(userId),
  });
}

// ---------------------------------------------------------------------------
// tier changes
// ---------------------------------------------------------------------------
/**
 * Change tier. Takes effect immediately; the price difference is settled by
 * the next monthly billing run rather than pro rated, which keeps billing to
 * one predictable charge a month.
 */
export async function setTier(db, business, actor, newTier) {
  if (!TIERS[newTier]) throw new Error("Unknown tier.");
  if (newTier === business.tier) return;

  // Downgrading below the current headcount would silently break the cap, so
  // refuse and let them remove people first.
  const target = TIERS[newTier];
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM business_members WHERE business_id = ? AND role <> 'owner'`)
    .bind(business.id)
    .first();
  if (countRow && countRow.n > target.maxEmployees) {
    throw new Error(
      `${target.name} allows ${target.maxEmployees} employees and you have ${countRow.n}. Remove some first.`
    );
  }

  await db.prepare(`UPDATE businesses SET tier = ? WHERE id = ?`).bind(newTier, business.id).run();

  await ledger.audit(db, {
    actorId: actor.id,
    action: "business.tier_changed",
    targetType: "business",
    targetId: business.id,
    detail: `${business.tier} -> ${newTier}`,
  });
}

// ---------------------------------------------------------------------------
// billing
// ---------------------------------------------------------------------------
export function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Charge one business for one month.
 *
 * The fee moves from the business account to bank equity, so tier income shows
 * up as real revenue on the solvency panel rather than appearing from nowhere.
 *
 * A business that cannot pay is marked overdue rather than having money taken
 * it does not have. Perks stop, because perksActive() checks paid_until, and
 * the ledger stays honest.
 */
export async function billBusiness(db, business, { period = null, now = new Date() } = {}) {
  const target = period || currentPeriod(now);
  const tier = tierOf(business);
  const amount = toCents(tier.monthly);

  const account = await businessAccount(db, business.id);
  if (!account) return { skipped: "no account" };

  const already = await db
    .prepare(`SELECT id FROM business_tier_charges WHERE business_id = ? AND period = ?`)
    .bind(business.id, target)
    .first();
  if (already) return { skipped: "already billed" };

  try {
    const res = await ledger.postEntry(db, {
      kind: "fee",
      memo: `${tier.name} tier, ${target}`,
      idempotencyKey: `tier:${business.id}:${target}`,
      postings: [
        { accountId: account.id, amountCents: -amount },
        { accountId: ledger.EQUITY_ACCOUNT_ID, amountCents: amount },
      ],
    });

    await db
      .prepare(
        `INSERT OR IGNORE INTO business_tier_charges
           (business_id, period, tier, amount_cents, entry_id, status)
         VALUES (?, ?, ?, ?, ?, 'paid')`
      )
      .bind(business.id, target, business.tier, amount, res.entryId)
      .run();

    // Paid up to the end of the month after this one.
    await db
      .prepare(
        `UPDATE businesses
            SET paid_until = datetime('now', '+1 month'), status = 'active'
          WHERE id = ?`
      )
      .bind(business.id)
      .run();

    return { charged: amount, period: target };
  } catch (err) {
    // Almost certainly the overdraft CHECK: they cannot afford the tier.
    await db
      .prepare(
        `INSERT OR IGNORE INTO business_tier_charges
           (business_id, period, tier, amount_cents, status)
         VALUES (?, ?, ?, ?, 'failed')`
      )
      .bind(business.id, target, business.tier, amount)
      .run();
    await db.prepare(`UPDATE businesses SET status = 'overdue' WHERE id = ?`).bind(business.id).run();

    await ledger.audit(db, {
      action: "business.billing_failed",
      targetType: "business",
      targetId: business.id,
      detail: `${target}: ${err.message}`,
    });
    return { failed: true, reason: err.message, period: target };
  }
}

/** Cron entry point. Bills every active business for the current month. */
export async function billAll(db, { now = new Date() } = {}) {
  if (now.getUTCDate() > 3) return { skipped: "not in billing window" };

  const { results } = await db
    .prepare(`SELECT * FROM businesses WHERE status IN ('active','overdue') ORDER BY id`)
    .all();

  let charged = 0;
  let failed = 0;
  let skipped = 0;

  for (const b of results) {
    const r = await billBusiness(db, b, { now });
    if (r.charged) charged++;
    else if (r.failed) failed++;
    else skipped++;
  }
  return { charged, failed, skipped };
}

// ---------------------------------------------------------------------------
// admin operations
// ---------------------------------------------------------------------------
// These bypass the owner checks that apply to customers, because staff need to
// resolve disputes, reverse fraudulent registrations, and fix mistakes. Every
// one of them is audit logged with the acting admin.

export async function listAllBusinesses(db, { query = "" } = {}) {
  const base = `SELECT b.*,
      (SELECT COUNT(*) FROM business_members m WHERE m.business_id = b.id) AS member_count,
      (SELECT COALESCE(SUM(a.balance_cents),0) FROM accounts a WHERE a.owner_business_id = b.id) AS balance_cents,
      u.discord_username AS owner_name, u.mc_username AS owner_mc
    FROM businesses b LEFT JOIN users u ON u.id = b.owner_user_id`;

  const stmt = query
    ? db
        .prepare(
          `${base} WHERE LOWER(b.firm_name) LIKE ?1 OR LOWER(b.display_name) LIKE ?1
           ORDER BY b.id DESC LIMIT 100`
        )
        .bind(`%${query.toLowerCase()}%`)
    : db.prepare(`${base} ORDER BY b.id DESC LIMIT 100`);

  const { results } = await stmt.all();
  return results;
}

export async function setBusinessStatus(db, businessId, status, actor) {
  if (!["active", "overdue", "suspended", "closed"].includes(status)) throw new Error("Bad status.");
  await db.prepare(`UPDATE businesses SET status = ? WHERE id = ?`).bind(status, businessId).run();
  await ledger.audit(db, {
    actorId: actor.id,
    action: "business.status_changed",
    targetType: "business",
    targetId: businessId,
    detail: status,
  });
}

/**
 * Move ownership to another member. Used when a firm changes hands in game, or
 * when someone registered a company that was not theirs.
 */
export async function transferOwnership(db, businessId, newOwnerUserId, actor) {
  const current = await db
    .prepare(`SELECT * FROM business_members WHERE business_id = ? AND role = 'owner'`)
    .bind(businessId)
    .first();

  const target = await db
    .prepare(`SELECT * FROM business_members WHERE business_id = ? AND user_id = ?`)
    .bind(businessId, newOwnerUserId)
    .first();
  if (!target) throw new Error("That person is not a member of this company.");

  const statements = [
    db.prepare(`UPDATE business_members SET role = 'owner' WHERE business_id = ? AND user_id = ?`)
      .bind(businessId, newOwnerUserId),
    db.prepare(`UPDATE businesses SET owner_user_id = ? WHERE id = ?`).bind(newOwnerUserId, businessId),
  ];
  if (current && current.user_id !== newOwnerUserId) {
    statements.push(
      db.prepare(`UPDATE business_members SET role = 'manager' WHERE business_id = ? AND user_id = ?`)
        .bind(businessId, current.user_id)
    );
  }
  await db.batch(statements);

  await ledger.audit(db, {
    actorId: actor.id,
    action: "business.ownership_transferred",
    targetType: "business",
    targetId: businessId,
    detail: `to user ${newOwnerUserId}`,
  });
}

/** Extend a paid-until date without taking money. For goodwill or comping. */
export async function grantPaidUntil(db, businessId, months, actor) {
  const n = Math.max(1, Math.min(24, parseInt(months, 10) || 1));
  await db
    .prepare(
      `UPDATE businesses
          SET paid_until = datetime(COALESCE(MAX(paid_until, datetime('now')), datetime('now')), '+' || ? || ' months'),
              status = 'active'
        WHERE id = ?`
    )
    .bind(n, businessId)
    .run();
  await ledger.audit(db, {
    actorId: actor.id,
    action: "business.comped",
    targetType: "business",
    targetId: businessId,
    detail: `${n} month(s) granted without charge`,
  });
}

/** Force a billing attempt now, outside the normal window. */
export async function billNow(db, businessId, actor) {
  const b = await getBusiness(db, businessId);
  if (!b) throw new Error("Company not found.");
  const res = await billBusiness(db, b, { now: new Date() });
  await ledger.audit(db, {
    actorId: actor.id,
    action: "business.billed_manually",
    targetType: "business",
    targetId: businessId,
    detail: JSON.stringify(res),
  });
  return res;
}

export async function adminRemoveMember(db, businessId, userId, actor) {
  const role = await roleFor(db, businessId, userId);
  if (!role) throw new Error("Not a member.");
  if (role === "owner") throw new Error("Transfer ownership before removing the owner.");
  await db
    .prepare(`DELETE FROM business_members WHERE business_id = ? AND user_id = ?`)
    .bind(businessId, userId)
    .run();
  await ledger.audit(db, {
    actorId: actor.id,
    action: "business.member_removed_by_staff",
    targetType: "business",
    targetId: businessId,
    detail: String(userId),
  });
}

export async function chargeHistory(db, businessId, limit = 12) {
  const { results } = await db
    .prepare(
      `SELECT * FROM business_tier_charges WHERE business_id = ? ORDER BY period DESC LIMIT ?`
    )
    .bind(businessId, limit)
    .all();
  return results;
}
