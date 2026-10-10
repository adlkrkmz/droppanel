-- Idempotent Keepa collector host telemetry (single row per collector_id).

CREATE TABLE IF NOT EXISTS keepa_collector_host_telemetry (
  collector_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  collected_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_keepa_collector_host_telemetry_collected
  ON keepa_collector_host_telemetry (collected_at DESC);
