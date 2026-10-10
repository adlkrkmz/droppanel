-- 30D Clicks auto-sync schedule per store (non-destructive). Run manually via psql.



ALTER TABLE stores

  ADD COLUMN IF NOT EXISTS clicks_30d_last_sync_at TIMESTAMPTZ NULL;



ALTER TABLE stores

  ADD COLUMN IF NOT EXISTS clicks_30d_next_sync_at TIMESTAMPTZ NULL;



ALTER TABLE stores

  ADD COLUMN IF NOT EXISTS clicks_30d_sync_status TEXT NULL;



ALTER TABLE stores

  ADD COLUMN IF NOT EXISTS clicks_30d_sync_error TEXT NULL;



ALTER TABLE stores

  ADD COLUMN IF NOT EXISTS clicks_30d_last_checked_count INTEGER NULL;



ALTER TABLE stores

  ADD COLUMN IF NOT EXISTS clicks_30d_last_updated_count INTEGER NULL;



CREATE INDEX IF NOT EXISTS idx_stores_next_clicks_30d_sync

  ON stores (clicks_30d_next_sync_at)

  WHERE status = 'active';


