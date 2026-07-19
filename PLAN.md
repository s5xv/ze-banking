# Z&E Bank — build plan

Client: V1 [2077] · Budget: 35k · Stack: Cloudflare Workers + D1
Treasury API: `https://api.democracycraft.net/economy` (OpenAPI v1)

---

## 0. The one idea everything else follows from

The bank holds **one pooled firm account** at the Treasury. Player balances are
not real Treasury accounts — they're rows in our own **double-entry ledger**.
Deposits move real money into the pool and credit an internal account;
withdrawals debit the internal account and push real money back out.

That gives one invariant the whole system is judged against:

```
Treasury pool balance  ==  sum(all customer balances) + bank equity
```

If that ever drifts, something is broken and money is either missing or
invented. A reconciliation job checks it continuously (§7).

---

## 1. Money representation

**Integer cents, everywhere. No floats, ever.**

The Treasury API returns amounts as decimal *strings* and explicitly warns that
JSON numbers corrupt them. D1 stores `INTEGER` (64-bit), which is exact.

- Parse: `"2500.00"` → `250000`
- Store: `amount_cents INTEGER NOT NULL`
- Render: `centsToAmount(250000)` → `"2500.00"`
- Send to Treasury: decimal string, never a number

Interest at 2–5% monthly compounding across thousands of accounts is precisely
where float error becomes visible theft. This is non-negotiable.

---

## 2. Schema (phase 1)

```
users              discord identity + verified minecraft link
accounts           id, owner_user_id, kind, status, balance_cents, created_at
                   kind:   checking | savings | internal_equity | internal_pool
                   status: active | frozen | closed
entries            journal header — one per money movement
                   id, kind, memo, idempotency_key UNIQUE, created_by, created_at
postings           id, entry_id, account_id, amount_cents (signed)
                   INVARIANT: sum(amount_cents) per entry_id = 0
deposits           treasury_posting_id UNIQUE, entry_id, account_id, amount_cents
withdrawals        id, account_id, amount_cents, status, idempotency_key UNIQUE,
                   treasury_txn_id, entry_id, failure_reason
                   status: pending | sent | failed | needs_review
interest_runs      account_id, period ('2026-07'), amount_cents
                   UNIQUE(account_id, period)   <-- prevents double interest
ledger_cursor      last processed Treasury feed cursor
audit_log          actor, action, target, before/after, created_at
```

`accounts.balance_cents` is a cached total, always written in the same D1
`batch()` as its postings. Postings remain the source of truth; the cache exists
so balance reads don't aggregate the whole table. Reconciliation re-derives it.

---

## 3. Deposits (money in)

1. Player is shown a payment command with a unique memo.
2. Money lands in the pooled firm account.
3. We learn about it two ways, and both are safe to run at once:
   - **Webhook** — `POST /api/v1/webhooks` registers a URL and returns a
     `secret`; deposits arrive pushed, near-instant.
   - **Cursor feed** — `/accounts/{id}/transactions/feed?since=<cursor>` with
     `nextCursor`/`hasMore`. Runs on a cron as the safety net for anything the
     webhook missed.
4. `deposits.treasury_posting_id` is `UNIQUE`. Whichever path sees it first
   creates the entry; the second is a no-op.

`postingId` — not `txnId` — is the idempotency key. `txnId` is shared by both
sides of a transfer and would collide.

Only **positive** postings count. Postings are double-entry at the Treasury
level too, so a negative amount is money *leaving* the pool.

---

## 4. Withdrawals (money out) — the dangerous path

Order matters. Debit internally **first**, then pay out.

```
1. BEGIN batch:
     - check status = active, balance >= amount
     - insert entry + postings (debit customer, credit pool-outbound)
     - insert withdrawal row, status='pending', idempotency_key = uuid()
   COMMIT
2. POST /api/v1/transfers/to-player
     header  Idempotency-Key: <that same key>
     body    { fromAccountId, toPlayerUuid, amount: "12.34", memo }
3. On 2xx        -> status='sent', store txnId
   On 4xx        -> reverse the entry, status='failed'
   On timeout /
      5xx / no
      response   -> status='needs_review'. DO NOT RETRY BLINDLY.
```

The failure mode this ordering chooses is deliberate: a stuck pending
withdrawal is annoying and fully recoverable. A double payout is money gone.

`needs_review` is resolved by the reconciler, which re-sends the *same*
`Idempotency-Key` — the Treasury will return the original result rather than
paying twice — or confirms via the feed whether it settled.

---

## 5. Interest

- Cron on the 1st of each month.
- For each eligible account: `INSERT INTO interest_runs (account_id, period)`.
  If the unique constraint rejects it, that period is already paid — skip.
- Only after that insert succeeds does the interest entry get written.

Interest is created by the bank, so it is **new liability against unchanged
assets**. Every payment reduces equity unless lending income covers it. The
admin dashboard surfaces this directly (§6) rather than letting it accumulate
invisibly.

---

## 6. Admin dashboard

Solvency panel, computed live:

```
Assets      = Treasury pool balance (from API)
Liabilities = sum of all customer balances
Equity      = Assets - Liabilities
Reserve floor = Liabilities x RESERVE_RATIO   (configurable, default 100%)
Safe to withdraw = max(0, Assets - Reserve floor)
```

"Safe to withdraw" is **read-only** — it reports a number, it does not move
money. Admin withdrawals go through the normal withdrawal path and are hard-
blocked below the reserve floor. At the default 100% ratio the bank is fully
reserved and cannot lend depositors' money; lowering it is an explicit,
logged decision by V1, not a default.

Also in phase 1: manual deposit/adjustment (as explicit journal entries with a
mandatory reason, always audit-logged), account search, freeze/unfreeze,
transaction explorer, drift alerts, pending/needs_review withdrawal queue.

---

## 7. Reconciliation

Hourly cron:

1. Pull the Treasury feed from the stored cursor.
2. Every Treasury posting must map to an internal entry, and vice versa.
3. Re-derive `sum(postings)` per account, compare to `balance_cents`.
4. Assert the §0 invariant.
5. Any drift → flag on the admin dashboard and stop auto-processing
   withdrawals until acknowledged.

A bank that can't prove its own books is worse than one that's briefly down.

---

## 8. Auth & identity

- Discord OAuth for login (same pattern as GFC — HMAC-signed session cookie,
  role read fresh from the DB each request).
- Minecraft account link **proven**, not typed: resolve via
  `/api/v1/accounts/by-player?name=`, then require a small verification payment
  carrying a one-time code. Self-declared usernames are not acceptable when
  they control where withdrawals go.
- Roles: `customer` | `staff` | `admin`.

---

## 9. Operational constraints

| Constraint | Consequence |
|---|---|
| 120 transfers/min (business key) | Payroll and interest runs need a queue + backoff, not a loop |
| JWT has `expiresAt`, `/auth/rotate` exists | Key rotation is a designed feature, not an afterthought |
| Business key can move all firm funds | Secret only, never in the repo, rotate on any suspicion |
| D1 is single-writer | Fine for correctness; batch writes, avoid long transactions |

---

## 10. Phase 1 deliverables (this contract)

1. Ledger core — schema, double-entry engine, cents math, invariant tests
2. Deposits — webhook + cursor feed, idempotent
3. Withdrawals — full state machine incl. `needs_review` recovery
4. Transfers between players (internal, instant, no Treasury round-trip)
5. Savings accounts + monthly interest with double-credit protection
6. Account freezing
7. Transaction history + statements
8. Admin dashboard — solvency, manual entries, queues, drift alerts
9. Reconciliation job
10. Discord auth + verified Minecraft linking
11. Light/dark UI in the zenet.redmont.app idiom
12. Deploy + handover docs

## Phase 2 (quoted separately)

CDs · joint accounts with multi-signer approval · credit cards · loans with
generated signable contracts · business accounts and the three tiers · auto
payroll · direct debits · scheduled transactions · spending alerts · savings
goals · public company profiles · per-business webhooks · admin Discord bot

---

## 11. Open questions for V1

1. **Reserve ratio.** Start fully reserved (100%)? Anything lower means
   depositors' money is lent out and a bank run is possible by design.
2. **Who funds interest?** At 2%/month savings and 3%/month CDs, deposits cost
   more than credit at 5%/month earns unless ~40% of the book is lent out
   continuously. Where does the shortfall come from?
3. **Default handling.** A player takes a loan and quits. What happens?
   There is no collections mechanism in Minecraft.
4. **Who holds admin?** Admin can move real money. Named people only.
5. **Charter.** Does DC's government regulate banks? Worth checking before
   launch, not after.
6. **Firm account** — confirm the pooled account id and that a BUSINESS key is
   issued via `/treasuryapi business issue`.

---

## 12. Risks stated plainly

- **The spec as written is not self-sustaining.** See Q2. Not a build problem,
  but it will be blamed on the build when it bites. Get the answer in writing.
- **The API key is the bank.** Whoever holds it can drain the firm.
- **Interest and payouts are the two places money can be invented or
  duplicated.** Both are protected by unique constraints rather than by
  application logic being careful, because application logic gets edited.
