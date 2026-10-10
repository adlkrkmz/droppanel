-- Global Keepa planner state, usage ledger, capacity alerts (Phase 2).
-- Additive only. Does not alter Stock Guard / eBay / keepa_token_state.

-- A) Per-ASIN scheduler state (not tenant-scoped)
CREATE TABLE IF NOT EXISTS global_keepa_planner_state (
  global_asin_id     BIGINT PRIMARY KEY REFERENCES global_amazon_asins(id) ON DELETE CASCADE,
  priority           SMALLINT NULL,
  last_checked_at    TIMESTAMPTZ NULL,
  next_check_at      TIMESTAMPTZ NULL,
  last_attempt_at    TIMESTAMPTZ NULL,
  last_success_at    TIMESTAMPTZ NULL,
  failure_count      INTEGER NOT NULL DEFAULT 0,
  last_failure_code  TEXT NULL,
  claimed_until      TIMESTAMPTZ NULL,
  claimed_by         TEXT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_global_keepa_planner_priority CHECK (
    priority IS NULL OR priority IN (0, 1, 2)
  )
);

CREATE INDEX IF NOT EXISTS idx_global_keepa_planner_next_check
  ON global_keepa_planner_state (next_check_at ASC NULLS FIRST);

CREATE INDEX IF NOT EXISTS idx_global_keepa_planner_sla
  ON global_keepa_planner_state (last_success_at ASC NULLS FIRST);

CREATE INDEX IF NOT EXISTS idx_global_keepa_planner_priority_next
  ON global_keepa_planner_state (priority, next_check_at ASC NULLS FIRST);

CREATE INDEX IF NOT EXISTS idx_global_keepa_planner_claimed
  ON global_keepa_planner_state (claimed_until);

-- FAZ 1.1 seq-scan fix: NULLS FIRST due list on identity table
CREATE INDEX IF NOT EXISTS idx_global_amazon_asins_next_check_nulls
  ON global_amazon_asins (next_check_at ASC NULLS FIRST)
  WHERE is_active = TRUE;

-- B) Request-level token accounting (not per-ASIN)
CREATE TABLE IF NOT EXISTS keepa_platform_usage (
  id                     BIGSERIAL PRIMARY KEY,
  request_id             TEXT NOT NULL,
  requested_asin_count   INTEGER NOT NULL,
  returned_product_count INTEGER NOT NULL,
  tokens_consumed        INTEGER NULL,
  tokens_left_after      INTEGER NULL,
  refill_rate            INTEGER NULL,
  processing_time_ms     INTEGER NULL,
  status                 TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_keepa_platform_usage_status CHECK (status IN (
    'OK',
    'PARTIAL',
    'CHECK_FAILED',
    'HTTP_429',
    'HTTP_5XX',
    'TIMEOUT',
    'NETWORK',
    'MALFORMED_JSON'
  ))
);

CREATE INDEX IF NOT EXISTS idx_keepa_platform_usage_created
  ON keepa_platform_usage (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_keepa_platform_usage_status_created
  ON keepa_platform_usage (status, created_at DESC);

-- C) Platform-only capacity alerts (not tenant notifications)
CREATE TABLE IF NOT EXISTS keepa_platform_capacity_alerts (
  id                    BIGSERIAL PRIMARY KEY,
  severity              TEXT NOT NULL,
  sla_status            TEXT NOT NULL,
  utilization_percent   NUMERIC(8,2) NULL,
  message               TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_keepa_platform_capacity_severity CHECK (severity IN (
    'HEALTHY', 'INFO', 'NOTICE', 'WARNING', 'CRITICAL'
  ))
);

CREATE INDEX IF NOT EXISTS idx_keepa_platform_capacity_alerts_created
  ON keepa_platform_capacity_alerts (created_at DESC);
