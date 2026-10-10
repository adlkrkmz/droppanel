-- 30D listing views (clicks) sync timestamp (non-destructive). Run manually via psql.
-- clicks_30d already exists in 021_listing_metrics_fields.sql

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS clicks_30d_checked_at TIMESTAMPTZ NULL;
