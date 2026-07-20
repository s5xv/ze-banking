# Testing Z&E Bank

Two automated suites, then a manual walkthrough for the parts that need a real
Minecraft account and real money.

```
node tests/money.test.mjs    # arithmetic, no database, instant
node tests/db.test.mjs       # database rules, runs against LOCAL D1 only
```

Neither touches the live database. `db.test.mjs` passes `--local` on every
call, so it works against the local copy in `.wrangler/state`.

---

## What the automated tests actually prove

`money.test.mjs` covers the layer every balance rests on: parsing decimal
strings to cents, formatting back, interest rounding, and the float trap this
module exists to avoid. If this fails, every number in the bank is suspect.

`db.test.mjs` proves the database really refuses the things the design claims
are impossible. Most of its tests are "this should be rejected":

- a customer account cannot go negative
- an idempotency key cannot be reused
- the same Treasury posting cannot be credited twice
- interest cannot be paid twice for one month
- a company cannot be billed twice for one month
- one Minecraft account cannot belong to two users
- a verification code cannot be reused

Every one of those is a rule that stops money being invented, lost, or paid
twice. If one starts passing when it should fail, that is not cosmetic.

---

## Manual walkthrough

Do this on the live site with small amounts, in this order. Each step depends
on the one before it.

### 1. Login and account creation
- Log in with Discord.
- A checking account should exist immediately, balance 0.00.
- **Check:** `/app` loads, shows one account, prompts you to verify.

### 2. Verification, the happy path
- Go to `/app/verify`, enter your Minecraft name.
- You should get a code and a `/pay-account business ZEB 1.00 VERIFY-...` command.
- Pay it from **that** Minecraft account.
- Press "I have paid, check now".
- **Check:** you come back verified AND the 1.00 lands in your balance. The
  verification payment is real money and is credited, not consumed.

### 3. Verification, the attack
This is the one that matters most. Ask someone else to pay your verification
code from **their** account.
- **Check:** you are NOT verified.
- **Check:** the audit log shows `verification.wrong_payer`.
- **Check:** their money is still credited somewhere, not lost.

If this fails, anyone can claim anyone's Minecraft account and withdraw to it.

### 4. Deposit
- Pay your deposit code.
- **Check:** balance rises by exactly what you sent, within 5 minutes, or
  immediately if the webhook is registered.
- Pay it a second time.
- **Check:** balance rises again. Two payments, two credits.

### 5. Double credit
- In admin, press "Check the Treasury now" several times in a row.
- **Check:** your balance does not change. The same postings are seen
  repeatedly and credited once.

### 6. Withdrawal
- Withdraw a small amount.
- **Check:** it arrives in game, and your balance drops by exactly that amount.
- **Check:** `/admin/withdrawals` shows nothing needing review.

### 7. Overdraft
- Try to withdraw more than you have.
- **Check:** refused with a clear message, no ledger entry created.

### 8. Transfer
- Transfer to another verified customer.
- **Check:** instant, their balance rises, yours falls by the same amount.
- Try transferring to an unverified or nonexistent name.
- **Check:** refused.

### 9. Savings and fixed deposits
- Open a savings account, move money in.
- Open a fixed deposit for 1 month.
- **Check:** you cannot withdraw or transfer from the locked deposit.
- **Check:** the source account fell by exactly the deposit amount.

### 10. Interest
Do not wait a month. In admin, set `savings_rate_bps`, then check the interest
run by hand once the month rolls, or temporarily test on a scratch database.
- **Check:** the amount matches balance x rate, calculated on the balance at
  the **start** of the month, not the current one.
- **Check:** running it twice pays once.

### 11. Scheduled payments
- Create one dated today.
- Wait for the 5 minute cron.
- **Check:** it pays once, and `next_run` moves forward.
- **Check:** it does not pay again on the next cron run.

### 12. Business
- Register a company using a real firm name.
- **Check:** a nonexistent firm name is refused.
- Add a member, switch tiers, use "Bill now".
- **Check:** the fee leaves the company account and equity rises by the same.
- Try billing again in the same month.
- **Check:** refused as already billed.

### 13. Reconciliation
- In admin, open Reconciliation.
- **Check:** drift is 0.00 and no unbalanced entries.

This is the single most important number in the system. If drift is ever
non-zero, stop and investigate before taking more deposits. Withdrawals pause
themselves automatically when it happens.

---

## Things that are known-untested

Be honest with V1 about these rather than discovering them together:

- **Treasury outbound transfers.** Nothing has actually paid a player yet. The
  first live withdrawal is the real test of `payPlayer` and the idempotency
  key behaviour.
- **The `needs_review` path.** It only triggers on a timeout or 5xx from the
  Treasury, which is hard to produce deliberately. It is the most dangerous
  code in the bank and the least exercised.
- **Webhook signature verification.** Unverified until a webhook is registered
  and a real deposit arrives through it.
- **Interest at scale.** Tested logically, never run across many accounts.
