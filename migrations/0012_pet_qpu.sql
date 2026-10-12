-- Quantum pet, the weekly collapse on IBM quantum hardware (worker/pet.ts, worker/qpu.ts, docs/CONTRACT-WEEK2.md).
-- Apply before deploying the Worker that reads these columns.
--
-- pet_actions.theta: MUTATE's RY angle (radians), so a day's log can be replayed as a circuit. NULL for other
--   gates and for mutates logged before this migration (such a day cannot run on hardware).
-- pet_days.source: 'simulator' or 'qpu'; NULL on older rows (the simulator). qpu_backend / qpu_job: the IBM
--   backend and job id of a hardware day. qpu_note: why a Sunday was drawn on the simulator after all.
-- pet_qpu_runs: one row per hardware collapse. status 'submitting' -> 'queued' -> 'running' -> 'done', or
--   'fallback' (the simulator measured `state` instead; `reason` says why). `state` is the day's final state
--   vector (JSON), kept until the run settles; `mids` the site's mid-circuit outcomes (JSON array); `qasm` the
--   exact circuit sent; `counts` the histogram of the distribution shots that repeated the site's
--   mid-circuit outcomes, all 1000 without any (JSON); `summary` the hardware vs simulator comparison (JSON); `usage_seconds` the QPU time IBM charged. The day's pet_days row is written when the
--   run settles, so the body stays on the previous day until then.

ALTER TABLE pet_actions ADD COLUMN theta REAL;

ALTER TABLE pet_days ADD COLUMN source TEXT;
ALTER TABLE pet_days ADD COLUMN qpu_backend TEXT;
ALTER TABLE pet_days ADD COLUMN qpu_job TEXT;
ALTER TABLE pet_days ADD COLUMN qpu_note TEXT;

CREATE TABLE IF NOT EXISTS pet_qpu_runs (
  day           INTEGER PRIMARY KEY,
  status        TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  collapse_at   INTEGER NOT NULL,
  actions       INTEGER NOT NULL,
  state         TEXT,
  mids          TEXT    NOT NULL DEFAULT '[]',
  two_qubit     INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0,
  polled_at     INTEGER,
  crn           TEXT,
  backend       TEXT,
  job_id        TEXT,
  chain         TEXT,
  qasm          TEXT,
  submitted_at  INTEGER,
  finished_at   INTEGER,
  bits          TEXT,
  mid_hw        TEXT,
  counts        TEXT,
  matched       INTEGER,
  summary       TEXT,
  usage_seconds REAL,
  reason        TEXT
);

CREATE INDEX IF NOT EXISTS pet_qpu_runs_status ON pet_qpu_runs(status, day);
