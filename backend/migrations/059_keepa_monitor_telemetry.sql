-- Keepa Monitor observability only. Additive. No business-state tables.
-- Does not alter planner eligibility, snapshots semantics, or eBay columns.

ALTER TABLE keepa_platform_usage
  ADD COLUMN IF NOT EXISTS caller TEXT NULL,
  ADD COLUMN IF NOT EXISTS tokens_before INTEGER NULL,
  ADD COLUMN IF NOT EXISTS refill_in INTEGER NULL,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER NULL,
  ADD COLUMN IF NOT EXISTS error_message TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_keepa_platform_usage_caller_created
  ON keepa_platform_usage (caller, created_at DESC);

CREATE TABLE IF NOT EXISTS keepa_asin_scan_events (
  id                 BIGSERIAL PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id         TEXT NULL,
  global_asin_id     BIGINT NULL,
  asin               TEXT NOT NULL,
  priority           SMALLINT NULL,
  consumer_count     INTEGER NULL,
  snapshot_status    TEXT NULL,
  decision_code      TEXT NULL,
  candidate_price    NUMERIC(12,2) NULL,
  amazon_price       NUMERIC(12,2) NULL,
  fba_count          INTEGER NULL,
  fbm_count          INTEGER NULL,
  verify_queued      BOOLEAN NOT NULL DEFAULT FALSE,
  tokens_used        INTEGER NULL,
  duration_ms        INTEGER NULL,
  error_type         TEXT NULL,
  caller             TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_keepa_asin_scan_events_created
  ON keepa_asin_scan_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_keepa_asin_scan_events_asin_created
  ON keepa_asin_scan_events (asin, created_at DESC);

CREATE TABLE IF NOT EXISTS keepa_monitor_samples (
  id                      BIGSERIAL PRIMARY KEY,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tokens_left             INTEGER NULL,
  backlog                 INTEGER NULL,
  unique_asins_processed  INTEGER NULL
);

CREATE INDEX IF NOT EXISTS idx_keepa_monitor_samples_created
  ON keepa_monitor_samples (created_at DESC);
