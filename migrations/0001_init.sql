-- Dirac registry, initial schema.
-- passports: one row per wallet; `bundle` is the passport JSON, `hash` its sha256 (hex).
-- seals: one row per seal, keyed by sealId (sha256 of the canonical seal JSON).

CREATE TABLE IF NOT EXISTS passports (
  wallet        TEXT PRIMARY KEY,
  hash          TEXT NOT NULL,
  bundle        TEXT NOT NULL,
  self_sig      TEXT NOT NULL,
  wallet_sig    TEXT NOT NULL,
  anchor_tx     TEXT,
  mode          TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seals (
  id            TEXT PRIMARY KEY,
  wallet        TEXT NOT NULL,
  doc_hash      TEXT NOT NULL,
  seal          TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS seals_wallet ON seals(wallet);
