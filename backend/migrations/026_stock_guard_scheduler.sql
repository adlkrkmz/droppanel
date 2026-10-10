-- Stock Guard Scheduler v1 (non-destructive). Run manually via psql.

-- A) Per-store Stock Guard settings
CREATE TABLE IF NOT EXISTS stock_guard_settings (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL,
  store_id BIGINT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  mode TEXT NOT NULL DEFAULT 'manual',
  price_alert_enabled BOOLEAN NOT NULL DEFAULT true,
  price_increase_percent_threshold NUMERIC(6,2) NOT NULL DEFAULT 10,
  price_increase_amount_threshold NUMERIC(12,2) NOT NULL DEFAULT 2,
  sold_scan_hours INTEGER NOT NULL DEFAULT 12,
  clicked_scan_hours INTEGER NOT NULL DEFAULT 24,
  normal_scan_hours INTEGER NOT NULL DEFAULT 72,
  auto_zero_no_price_requires_repeat BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_guard_settings_ws_store
  ON stock_guard_settings (workspace_id, store_id);

-- B) Listing scan scheduling on catalog
ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS source_next_check_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS source_check_priority TEXT NULL,
  ADD COLUMN IF NOT EXISTS source_last_status TEXT NULL,
  ADD COLUMN IF NOT EXISTS source_last_price NUMERIC(12,2) NULL,
  ADD COLUMN IF NOT EXISTS source_previous_price NUMERIC(12,2) NULL,
  ADD COLUMN IF NOT EXISTS source_price_changed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS source_risk_seen_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_store_catalog_source_next_check
  ON store_catalog_state (store_id, source_next_check_at)
  WHERE panel_hidden_at IS NULL AND current_status = 'live';

-- C) Keepa token state (workspace-scoped)
CREATE TABLE IF NOT EXISTS keepa_token_state (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL UNIQUE,
  tokens_left INTEGER NULL,
  tokens_updated_at TIMESTAMPTZ NULL,
  refill_rate_per_minute INTEGER NOT NULL DEFAULT 20,
  bucket_capacity INTEGER NOT NULL DEFAULT 1200,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- D) Scan job queue
CREATE TABLE IF NOT EXISTS stock_guard_scan_jobs (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL,
  store_id BIGINT NOT NULL,
  job_type TEXT NOT NULL DEFAULT 'source_scan',
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 100,
  estimated_tokens INTEGER NULL,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  risk_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_guard_jobs_ws_status_sched
  ON stock_guard_scan_jobs (workspace_id, status, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_stock_guard_jobs_ws_store_status
  ON stock_guard_scan_jobs (workspace_id, store_id, status);

-- E) Stock review price-increase fields
ALTER TABLE stock_review_items
  ADD COLUMN IF NOT EXISTS old_source_price NUMERIC(12,2) NULL,
  ADD COLUMN IF NOT EXISTS new_source_price NUMERIC(12,2) NULL,
  ADD COLUMN IF NOT EXISTS price_change_percent NUMERIC(8,2) NULL;
