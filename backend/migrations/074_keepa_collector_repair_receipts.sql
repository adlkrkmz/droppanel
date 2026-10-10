-- Additive Keepa collector repair receipts. Does not update or delete outbox rows.

CREATE TABLE IF NOT EXISTS keepa_collector_repair_receipts (
  request_id TEXT PRIMARY KEY,
  collector_id TEXT,
  collector_version TEXT,
  snapshot_started_at TIMESTAMPTZ NOT NULL,
  final_count INTEGER NOT NULL,
  final_hash TEXT NOT NULL,
  added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  preserved INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
