-- Qubit Arena: the daily tournament and its badges (worker/arena.ts, docs/CONTRACT-ARENA.md).
-- arena_tournament_entries: one commit per wallet per UTC day ("YYYY-MM-DD"), sealed by the
--   passport over sha256("dirac:arena:tournament:v1:" + day + ":" + commit). `circuit` (canonical
--   JSON) and `revealed_at` are set by the reveal, 21:00..23:59 UTC. At most 64 rows a day; the
--   Worker's insert carries the cap. A commit is single-use across all days.
-- arena_tournaments: the stored result of a resolved day, written once (INSERT OR IGNORE on the
--   day): standings (JSON, place order, circuits included), forfeits (JSON, entries that never
--   revealed) and the round-robin matrix (JSON, matrix[i][j] = pA with standings[i] as A).
-- arena_badges: podium rows, places 1..3 of a day with at least two revealed fighters.

CREATE TABLE IF NOT EXISTS arena_tournament_entries (
  day         TEXT    NOT NULL,
  wallet      TEXT    NOT NULL,
  "commit"    TEXT    NOT NULL UNIQUE,
  seal        TEXT    NOT NULL,
  entered_at  INTEGER NOT NULL,
  circuit     TEXT,
  revealed_at INTEGER,
  PRIMARY KEY (day, wallet)
);

CREATE INDEX IF NOT EXISTS arena_tournament_entries_order ON arena_tournament_entries(day, entered_at);

CREATE TABLE IF NOT EXISTS arena_tournaments (
  day         TEXT    PRIMARY KEY,
  resolved_at INTEGER NOT NULL,
  entries     INTEGER NOT NULL,
  revealed    INTEGER NOT NULL,
  standings   TEXT    NOT NULL,
  forfeits    TEXT    NOT NULL,
  matrix      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS arena_badges (
  wallet     TEXT    NOT NULL,
  day        TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'tournament',
  place      INTEGER NOT NULL,
  awarded_at INTEGER NOT NULL,
  PRIMARY KEY (wallet, day, kind)
);

CREATE INDEX IF NOT EXISTS arena_badges_day ON arena_badges(day, place);
