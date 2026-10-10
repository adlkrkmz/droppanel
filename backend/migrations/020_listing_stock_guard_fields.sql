-- Phase 3: Stock Guard + panel soft-hide + source status fields
-- Non-destructive: ADD COLUMN IF NOT EXISTS only

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS stock_guard_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS panel_hidden_at TIMESTAMPTZ NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS source_status TEXT NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS source_status_reason TEXT NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS source_price NUMERIC(12,2) NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS source_checked_at TIMESTAMPTZ NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS bot_zeroed_at TIMESTAMPTZ NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS bot_zeroed_reason TEXT NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS bot_zeroed_by TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_store_catalog_state_stock_guard
  ON store_catalog_state(store_id, stock_guard_enabled);

CREATE INDEX IF NOT EXISTS idx_store_catalog_state_panel_hidden
  ON store_catalog_state(store_id, panel_hidden_at);

CREATE INDEX IF NOT EXISTS idx_store_catalog_state_source_status
  ON store_catalog_state(store_id, source_status);
