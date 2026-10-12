-- Qubit Arena: a commit is single-use (worker/arena.ts `commit`, docs/CONTRACT-ARENA.md).
-- The queue never holds one commit twice, and the bout columns are indexed so the
-- "already fought" guard (a_commit = ? OR b_commit = ?) does not scan the table.
-- The Worker works without these (the guard is a query, not a constraint); they
-- make it cheap and close the race between two isolates queueing the same commit.

CREATE UNIQUE INDEX IF NOT EXISTS arena_queue_commit ON arena_queue("commit");
CREATE INDEX IF NOT EXISTS arena_bouts_a_commit ON arena_bouts(a_commit);
CREATE INDEX IF NOT EXISTS arena_bouts_b_commit ON arena_bouts(b_commit);
