-- Non-destructive: track which Keepa price field was used for source_price
ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS source_price_source TEXT NULL;
