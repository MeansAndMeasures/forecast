-- Last outcome of every polled source, one row per source, updated each tick.
--
-- Snapshots only record successes with data, so "FIRMS saw no fires" and
-- "METAR has been failing for three weeks" looked the same from the outside.
-- This table keeps the difference: status is ok, empty, disabled or error,
-- with the error text and the last time the source produced data.

CREATE TABLE IF NOT EXISTS source_runs (
  source        TEXT PRIMARY KEY,
  ran_at        INTEGER NOT NULL,      -- epoch ms of the tick
  status        TEXT NOT NULL,         -- ok | empty | disabled | error
  record_count  INTEGER NOT NULL DEFAULT 0,
  error         TEXT,                  -- truncated message when status = error
  last_ok_at    INTEGER,               -- epoch ms of the last run with status ok
  last_error_at INTEGER                -- epoch ms of the last run with status error
);
