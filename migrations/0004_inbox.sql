-- Inbox and invites.
-- inbox: one row per sealed letter; `envelope` is the Envelope JSON (ciphertext only),
--   `sender_sig` the sender's Ed25519 signature over SEND_MESSAGE(to, envelopeHash).
-- invites: one row per (inviter, invitee) pair; `tx` is the 0.0001 SOL memo transaction.

CREATE TABLE IF NOT EXISTS inbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  to_wallet   TEXT NOT NULL,
  from_wallet TEXT NOT NULL,
  envelope    TEXT NOT NULL,
  sender_sig  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS inbox_to ON inbox(to_wallet, created_at);

CREATE TABLE IF NOT EXISTS invites (
  from_wallet TEXT NOT NULL,
  to_wallet   TEXT NOT NULL,
  tx          TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_wallet, to_wallet)
);
