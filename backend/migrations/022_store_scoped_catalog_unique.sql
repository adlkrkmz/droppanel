-- Store-scoped catalog uniqueness (non-destructive).
-- Allows the same internal_sku in different stores within one workspace.
-- Run manually when ready; do not auto-apply in production without review.

-- Drop workspace-wide SKU unique (blocks per-store sync when SKU reused across stores)
ALTER TABLE store_catalog_state
  DROP CONSTRAINT IF EXISTS store_catalog_state_workspace_id_internal_sku_key;

-- Per-store SKU uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_catalog_state_ws_store_sku
  ON store_catalog_state (workspace_id, store_id, internal_sku);

-- One eBay item ID per store (partial — NULL/empty allowed)
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_catalog_state_store_ebay_item
  ON store_catalog_state (store_id, ebay_item_id)
  WHERE ebay_item_id IS NOT NULL AND trim(ebay_item_id) <> '';
