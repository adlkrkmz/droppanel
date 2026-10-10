-- Price guard audit fields on listings (non-destructive). Run manually via psql.

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS manual_price_updated_at TIMESTAMPTZ NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS auto_price_protected_at TIMESTAMPTZ NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS auto_price_old_ebay_price NUMERIC(12, 2) NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS auto_price_new_ebay_price NUMERIC(12, 2) NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS auto_price_reason TEXT NULL;
