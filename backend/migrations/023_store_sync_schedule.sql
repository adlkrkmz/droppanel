-- Store background sync schedule (non-destructive). Run manually via psql.

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS last_catalog_sync_at TIMESTAMPTZ NULL;

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS next_catalog_sync_at TIMESTAMPTZ NULL;

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS last_metrics_sync_at TIMESTAMPTZ NULL;

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS next_metrics_sync_at TIMESTAMPTZ NULL;

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS sync_status TEXT NULL;

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS sync_error TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_stores_next_catalog_sync
  ON stores (next_catalog_sync_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_stores_next_metrics_sync
  ON stores (next_metrics_sync_at)
  WHERE status = 'active';
