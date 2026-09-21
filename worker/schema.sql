-- SLA monitoring store (Cloudflare D1 / SQLite).
-- Safe to re-run: every statement is idempotent.

CREATE TABLE IF NOT EXISTS uploads (
  id                   TEXT PRIMARY KEY,
  filename             TEXT NOT NULL,
  uploaded_at          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'receiving',  -- receiving | complete | failed

  rows_received        INTEGER NOT NULL DEFAULT 0,  -- data lines the function read
  rows_rejected        INTEGER NOT NULL DEFAULT 0,  -- unusable, never stored
  rows_stored          INTEGER NOT NULL DEFAULT 0,  -- distinct checks after dedupe
  rows_duplicate       INTEGER NOT NULL DEFAULT 0,  -- second agent reporting the same check

  ts_iso_utc           INTEGER NOT NULL DEFAULT 0,
  ts_offset            INTEGER NOT NULL DEFAULT 0,
  ts_epoch             INTEGER NOT NULL DEFAULT 0,
  ts_assumed_utc       INTEGER NOT NULL DEFAULT 0,

  latency_converted    INTEGER NOT NULL DEFAULT 0,
  latency_missing      INTEGER NOT NULL DEFAULT 0,
  latency_negative     INTEGER NOT NULL DEFAULT 0,
  latency_unparseable  INTEGER NOT NULL DEFAULT 0,
  status_invalid       INTEGER NOT NULL DEFAULT 0,

  window_start         TEXT,
  window_end           TEXT,
  service_count        INTEGER NOT NULL DEFAULT 0,
  -- Derived from the data rather than assumed, because downtime minutes are
  -- (failed checks x this number) and a wrong interval silently scales the bill.
  interval_minutes     INTEGER NOT NULL DEFAULT 15
);

-- One row per *logical* check. The primary key is the dedupe rule: a check is
-- identified by which service was probed and when, not by which agent happened
-- to report it. Two agents reporting the same instant collapse into one row,
-- which also makes re-uploading the same file idempotent instead of doubling
-- the availability denominator.
CREATE TABLE IF NOT EXISTS checks (
  upload_id    TEXT NOT NULL,
  service_id   TEXT NOT NULL,
  ts           TEXT NOT NULL,           -- ISO-8601 UTC
  day          TEXT NOT NULL,           -- YYYY-MM-DD UTC, denormalised for date filters
  service_name TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  outcome      TEXT NOT NULL,           -- up | down | unknown
  latency_ms   REAL,                    -- NULL when missing or rejected as invalid
  latency_raw  TEXT,                    -- original reading, kept for audit
  latency_unit TEXT,                    -- original unit, kept for audit
  agent        TEXT NOT NULL,
  region       TEXT,
  PRIMARY KEY (upload_id, service_id, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_checks_day     ON checks (upload_id, day);
CREATE INDEX IF NOT EXISTS idx_checks_service ON checks (upload_id, service_id, day);
CREATE INDEX IF NOT EXISTS idx_checks_outcome ON checks (upload_id, outcome, ts);

-- Rows the function refused to store, so the dashboard can show what was
-- dropped instead of silently losing it.
CREATE TABLE IF NOT EXISTS rejected_rows (
  upload_id  TEXT NOT NULL,
  line       INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  raw        TEXT NOT NULL,
  PRIMARY KEY (upload_id, line)
);
