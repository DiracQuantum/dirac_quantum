-- Shared per-client request counters (fixed one-minute windows).
-- In-memory counters do not work: consecutive requests land on different isolates.
CREATE TABLE IF NOT EXISTS ratelimit (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
