-- Quantum pet: one shared 10-qubit register (worker/pet.ts).
-- pet_state: the single live row (id = 1): the current day, its state vector as JSON
--   ({ re: number[1024], im: number[1024] }), the protection map (qubit -> unix ms) and the gate count.
-- pet_days: one row per collapsed day with the measured bit string and its traits.
-- pet_actions: every gate applied, by day; `client` is a hash of the visitor's IP, never the IP.

CREATE TABLE IF NOT EXISTS pet_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  day            INTEGER NOT NULL,
  day_started_at INTEGER NOT NULL,
  state          TEXT    NOT NULL,
  protected      TEXT    NOT NULL DEFAULT '{}',
  actions_today  INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pet_days (
  day         INTEGER PRIMARY KEY,
  bits        TEXT    NOT NULL,
  form        TEXT    NOT NULL,
  character   TEXT    NOT NULL,
  ability     TEXT    NOT NULL,
  palette     TEXT    NOT NULL,
  actions     INTEGER NOT NULL,
  p_top       REAL    NOT NULL,
  measured_at INTEGER NOT NULL,
  posted_at   INTEGER
);

CREATE TABLE IF NOT EXISTS pet_actions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  day     INTEGER NOT NULL,
  gate    TEXT    NOT NULL,
  q       INTEGER NOT NULL,
  t       INTEGER,
  outcome INTEGER,
  client  TEXT    NOT NULL,
  at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS pet_actions_day ON pet_actions(day, at);
