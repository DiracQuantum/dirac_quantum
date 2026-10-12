-- Qubit Arena (worker/arena.ts, docs/CONTRACT-ARENA.md).
-- arena_ratings: one row per wallet that entered a ranked bout; ELO starts at 1200.
-- arena_queue:   at most one committed fighter per wallet waiting for an opponent;
--                `seal` is the passport's ML-DSA seal over the commit message.
-- arena_bouts:   one row per pairing. Circuits are stored as canonical JSON once
--                revealed; `result` is 'a' | 'b' | 'draw' | 'a_forfeit' | 'b_forfeit';
--                `seed` is sha256(dayBits + id) at pairing time.

CREATE TABLE IF NOT EXISTS arena_ratings (
  wallet     TEXT    PRIMARY KEY,
  elo        REAL    NOT NULL DEFAULT 1200,
  wins       INTEGER NOT NULL DEFAULT 0,
  losses     INTEGER NOT NULL DEFAULT 0,
  draws      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS arena_ratings_elo ON arena_ratings(elo DESC);

-- `commit` is a reserved word in SQLite: quoted here and in every statement that names it.
CREATE TABLE IF NOT EXISTS arena_queue (
  wallet    TEXT    PRIMARY KEY,
  "commit"  TEXT    NOT NULL,
  seal      TEXT    NOT NULL,
  queued_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS arena_queue_time ON arena_queue(queued_at);

CREATE TABLE IF NOT EXISTS arena_bouts (
  id            TEXT    PRIMARY KEY,
  a_wallet      TEXT    NOT NULL,
  b_wallet      TEXT    NOT NULL,
  a_commit      TEXT    NOT NULL,
  b_commit      TEXT    NOT NULL,
  a_circuit     TEXT,
  b_circuit     TEXT,
  a_revealed_at INTEGER,
  b_revealed_at INTEGER,
  paired_at     INTEGER NOT NULL,
  resolved_at   INTEGER,
  p_a           REAL,
  result        TEXT,
  seed          TEXT
);

CREATE INDEX IF NOT EXISTS arena_bouts_a ON arena_bouts(a_wallet, paired_at);
CREATE INDEX IF NOT EXISTS arena_bouts_b ON arena_bouts(b_wallet, paired_at);
CREATE INDEX IF NOT EXISTS arena_bouts_open ON arena_bouts(resolved_at, paired_at);
