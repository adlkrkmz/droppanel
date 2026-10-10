-- Additive collector bootstrap receipts. Does not delete outbox rows.

CREATE TABLE IF NOT EXISTS keepa_collector_bootstrap_receipts (
  request_id TEXT PRIMARY KEY,
  snapshot_started_at TIMESTAMPTZ NOT NULL,
  local_hash TEXT NOT NULL,
  local_count INTEGER NOT NULL,
  covered INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
