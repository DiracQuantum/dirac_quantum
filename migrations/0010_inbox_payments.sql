-- USDC with a sealed note (SPEC 3.4 extension, worker/inbox.ts, docs/CONTRACT-WEEK2.md).
-- inbox.payment_*: the payment a letter claims. payment_sig is the base58 transaction signature,
--   payment_amount USDC base units (6 decimals), payment_status 'verified' | 'pending' | 'invalid',
--   payment_reason why it is invalid, payment_checks how many times the chain answered "not visible yet",
--   payment_checked_at the unix ms of the last look. All NULL (checks 0) for a letter without a payment.
-- inbox_payments: one row per verified payment, keyed by signature, so one transaction pays for one
--   letter only. The row outlives a deleted letter on purpose: the signature stays spent.
--
-- SQLite has no IF NOT EXISTS for ADD COLUMN: wrangler records this file in d1_migrations and
-- runs it once, so the ALTERs are safe. Do not re-run it by hand against a database that has them.

ALTER TABLE inbox ADD COLUMN payment_sig TEXT;
ALTER TABLE inbox ADD COLUMN payment_amount INTEGER;
ALTER TABLE inbox ADD COLUMN payment_status TEXT;
ALTER TABLE inbox ADD COLUMN payment_reason TEXT;
ALTER TABLE inbox ADD COLUMN payment_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbox ADD COLUMN payment_checked_at INTEGER;

CREATE INDEX IF NOT EXISTS inbox_payment_sig ON inbox(payment_sig) WHERE payment_sig IS NOT NULL;

CREATE TABLE IF NOT EXISTS inbox_payments (
  signature  TEXT    PRIMARY KEY,
  letter_id  INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
