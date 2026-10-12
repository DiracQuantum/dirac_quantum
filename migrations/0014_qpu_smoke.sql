-- Verifying the IBM Quantum path before a hardware Sunday (worker/pet.ts, worker/qpu.ts, docs/CONTRACT-WEEK2.md).
-- Apply before deploying the Worker that reads these tables: the monthly QPU budget query (GET /api/pet,
-- the Sunday guard) now sums qpu_smoke too, so without this table GET /api/pet fails.
--
-- qpu_smoke: one row per POST /api/pet/qpu/smoke attempt. status 'submitting' -> 'queued' -> 'running' -> 'done',
--   or 'failed' (`reason` says why). The job is a Bell pair (H, CNOT, both measured) sent through the Sunday's
--   backend choice, ISA path, QASM emitter and Sampler V2 body: a 1-shot pub and a 200-shot pub, tagged
--   dirac-qpu-smoke-<id>-<created_at>. `crn` is the instance the job went to (read for polling, never returned
--   by the API), `pair` the two physical qubits (JSON [a, b], a gets the H), `counts` the 200-shot pub's
--   histogram (JSON, c[0] first), `collapse` the 1-shot pub's bits, `parsed` 1 when the Sunday's
--   parseSamplerResult read IBM's payload and 0 when it refused it, `shape` a keys-only skeleton of that payload,
--   `usage_seconds` the QPU time IBM charged (counted in the same monthly budget as the Sunday runs; a job
--   without reported usage counts 30 s), `polled_at` the shared poll claim (one poll per 30 s).
-- qpu_check: the cached result of GET /api/pet/qpu/check (one row, reused for 5 minutes) and the claim that
--   lets one isolate at a time ask IBM.

CREATE TABLE IF NOT EXISTS qpu_smoke (
  id            INTEGER PRIMARY KEY,
  status        TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  polled_at     INTEGER,
  crn           TEXT,
  backend       TEXT,
  pair          TEXT,
  job_id        TEXT,
  qasm          TEXT,
  submitted_at  INTEGER,
  finished_at   INTEGER,
  counts        TEXT,
  collapse      TEXT,
  parsed        INTEGER,
  shape         TEXT,
  usage_seconds REAL,
  reason        TEXT
);

CREATE INDEX IF NOT EXISTS qpu_smoke_status ON qpu_smoke(status, id);

CREATE TABLE IF NOT EXISTS qpu_check (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  result     TEXT    NOT NULL,
  checked_at INTEGER NOT NULL,
  claimed_at INTEGER
);
