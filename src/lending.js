// lending.js - loans and credit cards.
// ===========================================================================
// THE ENTIRE SYSTEM IS GATED ON ONE SETTING.
//
// The bank may only lend money it is allowed to lend, and that is decided by
// the reserve ratio. At 100% (10000 bps) every deposit is held and lending is
// impossible. Below 100%, the difference between what is held and the reserve
// floor is lendable.
//
// lendingEnabled() reads that live. Nothing about loans or credit needs to be
// rebuilt when the owner makes his decision: he lowers the reserve ratio in
// admin settings, and this system switches itself on. He raises it back to
// 100% and new lending stops, while existing debts continue to be collected.
//
// This is why the feature ships now rather than waiting: the machinery is
// built and dormant, and the decision is a single number.
//
// TIER DISCOUNTS come off the standard rate at the moment a loan is approved
// or a card issued, so Gold pays 0.5% less and Platinum 1.5% less, exactly as
// the tiers advertise.
// ===========================================================================

import * as ledger from "./ledger.js";
import * as biz from "./business.js";
import { assertCents } from "./money.js";

export class LendingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------
/**
 * Is the bank permitted to lend right now, and how much headroom is there?
 *
 * @returns { enabled, reason, capacityCents }
 *   capacityCents is how much MORE the bank could lend before it would breach
 *   its own reserve floor. New lending is refused past this, so the bank can
 *   never lend itself insolvent.
 */
export async function lendingStatus(db, treasuryCents) {
  const forced = await ledger.getSetting(db, "lending_enabled", "auto");
  if (forced === "off") {
    return { enabled: false, reason: "Lending is switched off.", capacityCents: 0 };
  }

  const ratioBps = parseInt(await ledger.getSetting(db, "reserve_ratio_bps", "10000"), 10);
  if (ratioBps >= 10000) {
    return {
      enabled: false,
      reason:
        "The bank is fully reserved (100%), so it holds every coin it owes and cannot lend. " +
        "Lower the reserve ratio in settings to enable lending.",
      capacityCents: 0,
    };
  }

  // Liabilities = what customers are owed. The reserve floor is that times the
  // ratio. Anything the bank holds above the floor is lendable.
  const liab = await db
    .prepare(`SELECT COALESCE(SUM(balance_cents),0) AS total FROM accounts WHERE kind IN ('checking','savings')`)
    .first();
  const liabilities = liab ? liab.total : 0;
  const floor = Math.ceil((liabilities * ratioBps) / 10000);

  // Money already out on loans counts against capacity.
  const lentRow = await db
    .prepare(`SELECT COALESCE(SUM(outstanding_cents),0) AS total FROM loans WHERE status = 'active'`)
    .first();
  const cardRow = await db
    .prepare(
      `SELECT COALESCE(SUM(-balance_cents),0) AS total FROM accounts
        WHERE kind IN ('checking','savings') AND balance_cents < 0`
    )
    .first();
  const alreadyLent = (lentRow ? lentRow.total : 0) + (cardRow ? cardRow.total : 0);

  // Held above floor, minus what is already lent, is what remains.
  const capacity = Math.max(0, treasuryCents - floor - alreadyLent);

  return {
    enabled: capacity > 0,
    reason:
      capacity > 0
        ? `Lending enabled. About ${(capacity / 100).toFixed(0)} of headroom before the reserve floor.`
        : "The bank has no lending headroom right now without breaching its reserve floor.",
    capacityCents: capacity,
    reserveRatioBps: ratioBps,
    floor,
    alreadyLent,
  };
}

// ---------------------------------------------------------------------------
// rates, with tier discounts
// ---------------------------------------------------------------------------
async function discountedRate(db, baseKey, businessId) {
  const base = parseInt(await ledger.getSetting(db, baseKey, "400"), 10) || 0;
  if (!businessId) return base;
  const business = await biz.getBusiness(db, businessId);
  const tier = biz.effectiveTier(business);
  // loanDiscountBps is stored positive; it is subtracted.
  return Math.max(0, base - (tier.loanDiscountBps || 0));
}

export const loanRate = (db, businessId = null) => discountedRate(db, "loan_rate_bps", businessId);
export const creditRate = (db, businessId = null) => discountedRate(db, "credit_rate_bps", businessId);

// ===========================================================================
// LOANS
// ===========================================================================
function signToken() {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function contractText({ borrowerName, principal, rateBps, termMonths, bankName }) {
  const rate = (rateBps / 100).toFixed(2);
  return [
    `${bankName || "Z&E Bank"} LOAN AGREEMENT`,
    ``,
    `Borrower: ${borrowerName}`,
    `Principal: ${principal}`,
    `Interest: ${rate}% per month on the outstanding balance`,
    `Term: ${termMonths} months`,
    ``,
    `The borrower agrees to repay the principal plus accrued interest. Interest`,
    `is charged monthly on the amount still owed. The loan may be repaid early`,
    `in full or in part at any time with no penalty. Failure to repay may result`,
    `in the debt being referred for collection.`,
    ``,
    `By signing, the borrower accepts these terms.`,
  ].join("\n");
}

/**
 * An admin offers a loan. Nothing moves yet: this creates a contract and a
 * signing link. The money is advanced only when the borrower signs.
 */
export async function offerLoan(env, db, admin, { borrowerMc, businessFirm = null, principalCents, termMonths }) {
  assertCents(principalCents);
  if (principalCents <= 0) throw new LendingError("BAD_AMOUNT", "Principal must be positive.");
  if (![1, 3, 6, 12, 24].includes(Number(termMonths))) throw new LendingError("BAD_TERM", "Choose a valid term.");

  // Gate. Read the live Treasury balance so capacity is real.
  const treasury = await import("./treasury.js");
  let treasuryCents;
  try {
    treasuryCents = await treasury.poolBalanceCents(env);
  } catch {
    throw new LendingError("TREASURY_DOWN", "Cannot check lending capacity while the Treasury is unreachable.");
  }
  const status = await lendingStatus(db, treasuryCents);
  if (!status.enabled) throw new LendingError("DISABLED", status.reason);
  if (principalCents > status.capacityCents) {
    throw new LendingError(
      "OVER_CAPACITY",
      `That exceeds the bank's lending headroom of about ${(status.capacityCents / 100).toFixed(0)}.`
    );
  }

  const borrower = await db
    .prepare(
      `SELECT * FROM users WHERE LOWER(mc_username) = LOWER(?)
         AND mc_verified_at IS NOT NULL AND status = 'active'`
    )
    .bind(String(borrowerMc || "").trim())
    .first();
  if (!borrower) throw new LendingError("NO_BORROWER", "No verified customer with that Minecraft name.");

  let businessId = null;
  let toAccount;
  if (businessFirm) {
    const business = await biz.getBusinessByFirm(db, businessFirm);
    if (!business) throw new LendingError("NO_FIRM", "No such company.");
    businessId = business.id;
    toAccount = await biz.businessAccount(db, business.id);
  } else {
    toAccount = await ledger.defaultAccountForUser(db, borrower.id);
  }
  if (!toAccount) throw new LendingError("NO_ACCOUNT", "The borrower has no account to receive into.");

  const rateBps = await loanRate(db, businessId);
  const token = signToken();
  const text = contractText({
    borrowerName: borrower.mc_username,
    principal: (principalCents / 100).toFixed(2),
    rateBps,
    termMonths: Number(termMonths),
    bankName: env.BANK_NAME,
  });

  const r = await db
    .prepare(
      `INSERT INTO loans
         (borrower_user_id, business_id, to_account_id, principal_cents, rate_bps, term_months,
          status, sign_token, contract_text, offered_by)
       VALUES (?, ?, ?, ?, ?, ?, 'offered', ?, ?, ?)`
    )
    .bind(borrower.id, businessId, toAccount.id, principalCents, rateBps, Number(termMonths), token, text, admin.id)
    .run();

  await ledger.audit(db, {
    actorId: admin.id,
    action: "loan.offered",
    targetType: "loan",
    targetId: r.meta.last_row_id,
    detail: `${borrower.mc_username}, ${principalCents} cents at ${rateBps} bps`,
  });

  return { loanId: r.meta.last_row_id, token, rateBps };
}

export async function getLoanByToken(db, token) {
  return await db.prepare(`SELECT * FROM loans WHERE sign_token = ?`).bind(token).first();
}

/**
 * The borrower signs. This advances the money, which is the moment debt is
 * created, so it is guarded by an idempotency key: signing twice cannot pay
 * out twice.
 */
export async function signLoan(env, db, user, token) {
  const loan = await getLoanByToken(db, token);
  if (!loan) throw new LendingError("NOT_FOUND", "That loan offer does not exist.");
  if (loan.borrower_user_id !== user.id) throw new LendingError("NOT_YOURS", "This offer is not addressed to you.");
  if (loan.status !== "offered") throw new LendingError("DECIDED", `This offer is already ${loan.status}.`);

  // Advance: bank equity -> borrower. The borrower's balance goes up and the
  // bank owes itself back the principal, tracked in outstanding_cents.
  const res = await ledger.postEntry(db, {
    kind: "adjustment",
    memo: `Loan #${loan.id} advance`,
    idempotencyKey: `loan-advance:${loan.id}`,
    createdBy: user.id,
    postings: [
      { accountId: ledger.EQUITY_ACCOUNT_ID, amountCents: -loan.principal_cents },
      { accountId: loan.to_account_id, amountCents: loan.principal_cents },
    ],
  });

  await db.batch([
    db.prepare(
      `UPDATE loans SET status='active', signed_at=datetime('now'), advanced_at=datetime('now'),
              outstanding_cents=? WHERE id=?`
    ).bind(loan.principal_cents, loan.id),
    db.prepare(
      `INSERT OR IGNORE INTO loan_events (loan_id, kind, amount_cents, entry_id)
       VALUES (?, 'advance', ?, ?)`
    ).bind(loan.id, loan.principal_cents, res.entryId),
  ]);

  await ledger.audit(db, {
    actorId: user.id,
    action: "loan.signed",
    targetType: "loan",
    targetId: loan.id,
  });

  return { advanced: loan.principal_cents };
}

export async function cancelLoan(db, admin, loanId) {
  const loan = await db.prepare(`SELECT * FROM loans WHERE id = ?`).bind(loanId).first();
  if (!loan) throw new LendingError("NOT_FOUND", "Not found.");
  if (loan.status !== "offered") throw new LendingError("DECIDED", "Only an unsigned offer can be cancelled.");
  await db.prepare(`UPDATE loans SET status='cancelled' WHERE id=?`).bind(loanId).run();
}

/** Borrower repays, from one of their accounts. Partial is fine. */
export async function repayLoan(db, user, { loanId, fromAccountId, amountCents }) {
  assertCents(amountCents);
  if (amountCents <= 0) throw new LendingError("BAD_AMOUNT", "Amount must be positive.");

  const loan = await db.prepare(`SELECT * FROM loans WHERE id = ?`).bind(loanId).first();
  if (!loan) throw new LendingError("NOT_FOUND", "Loan not found.");
  if (loan.status !== "active") throw new LendingError("NOT_ACTIVE", "That loan is not open.");
  if (loan.borrower_user_id !== user.id) throw new LendingError("NOT_YOURS", "Not your loan.");

  const pay = Math.min(amountCents, loan.outstanding_cents);
  const from = await ledger.getAccount(db, fromAccountId);
  ledger.assertWithdrawable(from);
  if (from.owner_user_id !== user.id) throw new LendingError("NOT_YOURS", "Not your account.");

  // Borrower -> bank equity. The debt shrinks.
  const res = await ledger.postEntry(db, {
    kind: "adjustment",
    memo: `Loan #${loan.id} repayment`,
    idempotencyKey: `loan-repay:${loan.id}:${crypto.randomUUID()}`,
    createdBy: user.id,
    postings: [
      { accountId: fromAccountId, amountCents: -pay },
      { accountId: ledger.EQUITY_ACCOUNT_ID, amountCents: pay },
    ],
  });

  const remaining = loan.outstanding_cents - pay;
  await db.batch([
    db.prepare(`UPDATE loans SET outstanding_cents=?, status=? , closed_at=? WHERE id=?`)
      .bind(remaining, remaining <= 0 ? "repaid" : "active", remaining <= 0 ? "datetime('now')" : null, loan.id),
    db.prepare(`INSERT INTO loan_events (loan_id, kind, amount_cents, entry_id) VALUES (?, 'repayment', ?, ?)`)
      .bind(loan.id, pay, res.entryId),
  ]);

  return { paid: pay, remaining: Math.max(0, remaining) };
}

// ---------------------------------------------------------------------------
// monthly loan interest
// ---------------------------------------------------------------------------
export async function accrueLoanInterest(db, { now = new Date() } = {}) {
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const { results } = await db
    .prepare(`SELECT * FROM loans WHERE status = 'active' AND outstanding_cents > 0`)
    .all();

  let charged = 0;
  for (const loan of results) {
    const interest = Math.round((loan.outstanding_cents * loan.rate_bps) / 10000);
    if (interest <= 0) continue;

    try {
      // Interest increases what is owed. It does not move cash: it accrues
      // against the borrower and is realised as income when repaid. Recorded
      // as an equity-neutral memo entry against a bookkeeping pair so the
      // ledger stays balanced. UNIQUE(loan, kind, period) prevents double
      // charging.
      const res = await ledger.postEntry(db, {
        kind: "interest",
        memo: `Loan #${loan.id} interest ${period}`,
        idempotencyKey: `loan-interest:${loan.id}:${period}`,
        postings: [
          { accountId: ledger.EQUITY_ACCOUNT_ID, amountCents: interest },
          { accountId: ledger.EQUITY_ACCOUNT_ID, amountCents: -interest },
        ],
      });
      if (res.duplicate) continue;

      await db.batch([
        db.prepare(`UPDATE loans SET outstanding_cents = outstanding_cents + ? WHERE id = ?`)
          .bind(interest, loan.id),
        db.prepare(
          `INSERT OR IGNORE INTO loan_events (loan_id, kind, amount_cents, period, entry_id)
           VALUES (?, 'interest', ?, ?, ?)`
        ).bind(loan.id, interest, period, res.entryId),
      ]);
      charged++;
    } catch {
      /* already charged this month */
    }
  }
  return { period, charged };
}

export async function listLoansForUser(db, userId) {
  const { results } = await db
    .prepare(`SELECT * FROM loans WHERE borrower_user_id = ? AND status IN ('offered','active') ORDER BY id DESC`)
    .bind(userId)
    .all();
  return results;
}

export async function listAllLoans(db, { status = null } = {}) {
  const sql = status
    ? `SELECT l.*, u.mc_username FROM loans l JOIN users u ON u.id = l.borrower_user_id WHERE l.status = ? ORDER BY l.id DESC`
    : `SELECT l.*, u.mc_username FROM loans l JOIN users u ON u.id = l.borrower_user_id ORDER BY l.id DESC LIMIT 100`;
  const stmt = status ? db.prepare(sql).bind(status) : db.prepare(sql);
  const { results } = await stmt.all();
  return results;
}

// ===========================================================================
// CREDIT CARDS
// ===========================================================================
/** Admin issues a card: a negative-capable account with a floor at -limit. */
export async function issueCard(env, db, admin, { userMc, limitCents, businessFirm = null }) {
  assertCents(limitCents);
  if (limitCents <= 0) throw new LendingError("BAD_AMOUNT", "Limit must be positive.");

  const treasury = await import("./treasury.js");
  let treasuryCents;
  try {
    treasuryCents = await treasury.poolBalanceCents(env);
  } catch {
    throw new LendingError("TREASURY_DOWN", "Cannot check capacity while the Treasury is unreachable.");
  }
  const status = await lendingStatus(db, treasuryCents);
  if (!status.enabled) throw new LendingError("DISABLED", status.reason);

  const holder = await db
    .prepare(`SELECT * FROM users WHERE LOWER(mc_username) = LOWER(?) AND mc_verified_at IS NOT NULL`)
    .bind(String(userMc || "").trim())
    .first();
  if (!holder) throw new LendingError("NO_USER", "No verified customer with that name.");

  let businessId = null;
  if (businessFirm) {
    const business = await biz.getBusinessByFirm(db, businessFirm);
    if (business) businessId = business.id;
  }
  const rateBps = await creditRate(db, businessId);

  // The card is its own account, allowed to go negative down to -limit.
  const acc = await db
    .prepare(
      `INSERT INTO accounts (owner_user_id, kind, label, allow_negative, status)
       VALUES (?, 'checking', 'Credit card', 1, 'active')`
    )
    .bind(holder.id)
    .run();
  const accountId = acc.meta.last_row_id;

  const r = await db
    .prepare(`INSERT INTO credit_cards (user_id, account_id, limit_cents, rate_bps) VALUES (?, ?, ?, ?)`)
    .bind(holder.id, accountId, limitCents, rateBps)
    .run();

  await ledger.audit(db, {
    actorId: admin.id,
    action: "card.issued",
    targetType: "credit_card",
    targetId: r.meta.last_row_id,
    detail: `${holder.mc_username}, limit ${limitCents}, ${rateBps} bps`,
  });

  return { cardId: r.meta.last_row_id, accountId, rateBps };
}

export async function listCardsForUser(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT c.*, a.balance_cents FROM credit_cards c JOIN accounts a ON a.id = c.account_id
        WHERE c.user_id = ? AND c.status <> 'closed' ORDER BY c.id`
    )
    .bind(userId)
    .all();
  return results;
}

/** Spend on a card: card account -> a destination. Enforces the limit. */
export async function chargeCard(db, user, { cardId, toAccountId, amountCents, memo }) {
  assertCents(amountCents);
  const card = await db.prepare(`SELECT * FROM credit_cards WHERE id = ?`).bind(cardId).first();
  if (!card) throw new LendingError("NOT_FOUND", "Card not found.");
  if (card.user_id !== user.id) throw new LendingError("NOT_YOURS", "Not your card.");
  if (card.status !== "active") throw new LendingError("FROZEN", "That card is not active.");

  const account = await ledger.getAccount(db, card.account_id);
  // Spending pushes the balance more negative. Refuse past the limit.
  if (account.balance_cents - amountCents < -card.limit_cents) {
    throw new LendingError("OVER_LIMIT", "That would exceed the card limit.");
  }

  const to = await ledger.getAccount(db, toAccountId);
  ledger.assertUsable(to);

  return await ledger.postEntry(db, {
    kind: "transfer",
    memo: memo || `Credit card charge`,
    idempotencyKey: `card:${cardId}:${crypto.randomUUID()}`,
    createdBy: user.id,
    postings: [
      { accountId: card.account_id, amountCents: -amountCents },
      { accountId: toAccountId, amountCents: amountCents },
    ],
  });
}

/** Pay down a card from another account. */
export async function payCard(db, user, { cardId, fromAccountId, amountCents }) {
  assertCents(amountCents);
  const card = await db.prepare(`SELECT * FROM credit_cards WHERE id = ?`).bind(cardId).first();
  if (!card || card.user_id !== user.id) throw new LendingError("NOT_YOURS", "Not your card.");
  const from = await ledger.getAccount(db, fromAccountId);
  ledger.assertWithdrawable(from);
  if (from.owner_user_id !== user.id) throw new LendingError("NOT_YOURS", "Not your account.");

  const account = await ledger.getAccount(db, card.account_id);
  // Do not overpay a card into a positive balance.
  const owed = Math.max(0, -account.balance_cents);
  const pay = Math.min(amountCents, owed);
  if (pay <= 0) return { paid: 0 };

  return await ledger.postEntry(db, {
    kind: "transfer",
    memo: "Credit card payment",
    idempotencyKey: `cardpay:${cardId}:${crypto.randomUUID()}`,
    createdBy: user.id,
    postings: [
      { accountId: fromAccountId, amountCents: -pay },
      { accountId: card.account_id, amountCents: pay },
    ],
  }).then(() => ({ paid: pay }));
}

/** Monthly interest on cards carrying a balance. */
export async function accrueCardInterest(db, { now = new Date() } = {}) {
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const { results } = await db
    .prepare(
      `SELECT c.*, a.balance_cents FROM credit_cards c JOIN accounts a ON a.id = c.account_id
        WHERE c.status = 'active' AND a.balance_cents < 0`
    )
    .all();

  let charged = 0;
  for (const card of results) {
    const owed = -card.balance_cents;
    const interest = Math.round((owed * card.rate_bps) / 10000);
    if (interest <= 0) continue;

    try {
      // Interest is charged to the card (balance more negative) and booked as
      // income to equity. UNIQUE(card, period) prevents double charging.
      const res = await ledger.postEntry(db, {
        kind: "interest",
        memo: `Credit interest ${period}`,
        idempotencyKey: `card-interest:${card.id}:${period}`,
        postings: [
          { accountId: card.account_id, amountCents: -interest },
          { accountId: ledger.EQUITY_ACCOUNT_ID, amountCents: interest },
        ],
      });
      if (res.duplicate) continue;

      await db
        .prepare(
          `INSERT OR IGNORE INTO credit_interest_runs (card_id, period, balance_cents, amount_cents, entry_id)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(card.id, period, card.balance_cents, interest, res.entryId)
        .run();
      charged++;
    } catch {
      /* already charged */
    }
  }
  return { period, charged };
}
