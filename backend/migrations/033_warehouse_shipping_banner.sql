-- Per-store warehouse shipping banner on product images (default off).
-- Apply manually via psql while PostgreSQL is running.

ALTER TABLE store_settings
  ADD COLUMN IF NOT EXISTS warehouse_shipping_banner_enabled BOOLEAN NOT NULL DEFAULT false;
