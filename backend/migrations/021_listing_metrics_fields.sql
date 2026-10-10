-- Phase 4: eBay listing metrics (non-destructive)

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS total_sold INTEGER NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS sold_30d INTEGER NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS clicks_30d INTEGER NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS views_30d INTEGER NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS impressions_30d INTEGER NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS watch_count INTEGER NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS metrics_synced_at TIMESTAMPTZ NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS metrics_source TEXT NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS metrics_error TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_store_catalog_state_metrics_store
  ON store_catalog_state(store_id, metrics_synced_at);

CREATE INDEX IF NOT EXISTS idx_store_catalog_state_total_sold
  ON store_catalog_state(store_id, total_sold);

CREATE INDEX IF NOT EXISTS idx_store_catalog_state_views_30d
  ON store_catalog_state(store_id, views_30d);
