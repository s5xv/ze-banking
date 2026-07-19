-- Migration 002 - bank funding code
-- ===========================================================================
--   npx wrangler d1 execute ze-bank --remote --file=migrations/002_bank_funding.sql
--
-- Safe to run repeatedly: the UPDATE matches nothing on a second run.
--
-- WHY THIS EXISTS
-- The owner has said he will personally cover the gap between interest paid
-- out and income earned. That is a workable answer, but only if the money is
-- recorded as what it is: bank capital, not a customer balance.
--
-- Giving the equity account its own deposit code means the owner can top the
-- bank up with a normal in-game payment, and it lands in equity automatically
-- instead of sitting in suspense as an unattributable deposit. Every injection
-- then shows up on the books, and the admin dashboard can show exactly how
-- much has been put in versus how much interest has been paid out.
--
-- Without this, a subsidy is indistinguishable from a mystery deposit.
-- ===========================================================================

UPDATE accounts
   SET deposit_code = lower(hex(randomblob(8)))
 WHERE id = 2
   AND kind = 'internal_equity'
   AND deposit_code IS NULL;
