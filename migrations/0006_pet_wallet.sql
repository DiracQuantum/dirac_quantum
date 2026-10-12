-- Quantum pet, wallet-signed gates and badges (worker/pet.ts, docs/CONTRACT-WEEK2.md).
-- pet_actions.wallet: the base58 wallet that signed the gate, NULL for an anonymous one.
-- pet_nonces: every nonce a signed gate has spent; a second request with the same nonce is refused.
-- pet_badges: one row per (wallet, day, kind), kind = 'witness' | 'influencer', awarded at the collapse.
-- pet_days.top_wallet / top_gates: the wallet with the most signed gates that day and its count.
--
-- SQLite has no IF NOT EXISTS for ADD COLUMN: wrangler records this file in d1_migrations and
-- runs it once, so the ALTERs are safe. Do not re-run it by hand against a database that has them.

ALTER TABLE pet_actions ADD COLUMN wallet TEXT;

CREATE INDEX IF NOT EXISTS pet_actions_wallet ON pet_actions(day, wallet);

CREATE TABLE IF NOT EXISTS pet_nonces (
  nonce  TEXT    PRIMARY KEY,
  wallet TEXT    NOT NULL,
  at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS pet_nonces_at ON pet_nonces(at);

CREATE TABLE IF NOT EXISTS pet_badges (
  wallet TEXT    NOT NULL,
  day    INTEGER NOT NULL,
  kind   TEXT    NOT NULL,
  PRIMARY KEY (wallet, day, kind)
);

ALTER TABLE pet_days ADD COLUMN top_wallet TEXT;
ALTER TABLE pet_days ADD COLUMN top_gates INTEGER;
