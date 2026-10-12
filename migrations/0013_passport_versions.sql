-- Passport rotation and anchor verification (worker/index.ts registry, docs/CONTRACT.md "Registry v2").
-- Apply right before deploying the Worker that reads these columns.
--
-- passport_versions: every passport a wallet has registered, version 1 first. Replacing the active
--   passport (a different hash) needs rotation_sig, an ML-DSA-65 signature by the previous version's key
--   over ROTATE_MESSAGE(wallet, old hash, new hash) (src/lib/pq.ts); the previous row gets superseded_at.
--   anchor_tx is the memo transaction the client named: anchor_verified = 1 once the Worker found it on
--   chain (signer = wallet, SPL Memo = ANCHOR_MEMO(passport), no error), with its slot and block time
--   (anchor_time, unix ms). A claim not visible on chain yet stays at 0 and is re-checked on read, at most
--   once a minute (anchor_checked_at, unix ms).
--
-- passports keeps one row per wallet, the active version: `version` points into passport_versions, and
--   anchor_tx now holds a VERIFIED anchor only (NULL otherwise), with anchor_verified / anchor_time beside
--   it. Readers of passports.anchor_tx (badge, share cards, scanner) therefore never show an unverified
--   anchor as anchored.
--
-- Backfill: each existing passport becomes version 1 with its anchor as an unverified claim; the active
--   row's anchor_tx is cleared until the Worker verifies it, which happens on the first
--   GET /api/passports/:wallet (or /history) after the deploy.

CREATE TABLE IF NOT EXISTS passport_versions (
  wallet            TEXT    NOT NULL,
  version           INTEGER NOT NULL,
  hash              TEXT    NOT NULL,
  bundle            TEXT    NOT NULL,
  self_sig          TEXT    NOT NULL,
  wallet_sig        TEXT    NOT NULL,
  rotation_sig      TEXT,
  anchor_tx         TEXT,
  anchor_verified   INTEGER NOT NULL DEFAULT 0,
  anchor_slot       INTEGER,
  anchor_time       INTEGER,
  anchor_checked_at INTEGER,
  mode              TEXT    NOT NULL,
  registered_at     INTEGER NOT NULL,
  superseded_at     INTEGER,
  PRIMARY KEY (wallet, version)
);

INSERT OR IGNORE INTO passport_versions
  (wallet, version, hash, bundle, self_sig, wallet_sig, rotation_sig, anchor_tx, anchor_verified,
   anchor_slot, anchor_time, anchor_checked_at, mode, registered_at, superseded_at)
SELECT wallet, 1, hash, bundle, self_sig, wallet_sig, NULL, anchor_tx, 0,
       NULL, NULL, NULL, mode, registered_at, NULL
FROM passports;

ALTER TABLE passports ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE passports ADD COLUMN anchor_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE passports ADD COLUMN anchor_time INTEGER;

UPDATE passports SET anchor_tx = NULL, anchor_verified = 0, anchor_time = NULL;
