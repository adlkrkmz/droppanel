-- Durable, append-only evidence for each eBay catalog sync. No catalog rows are changed here.
CREATE TABLE IF NOT EXISTS ebay_catalog_sync_receipts (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  store_code TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL CHECK (status IN ('completed','incomplete','failed')),
  expected_total_entries INTEGER NULL, expected_total_pages INTEGER NULL, requested_page_size INTEGER NOT NULL,
  pages_attempted INTEGER NOT NULL, pages_completed INTEGER NOT NULL, last_completed_page INTEGER NOT NULL,
  fetched_row_count INTEGER NOT NULL, distinct_remote_item_count INTEGER NOT NULL, duplicate_remote_item_count INTEGER NOT NULL,
  fetch_error_count INTEGER NOT NULL, first_error TEXT NULL, pagination_completed BOOLEAN NOT NULL,
  totals_consistent BOOLEAN NOT NULL, reconciliation_eligible BOOLEAN NOT NULL, reconciliation_ran BOOLEAN NOT NULL,
  reconciliation_ended_count INTEGER NOT NULL DEFAULT 0, error_message TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_ebay_catalog_sync_receipts_store_completed
  ON ebay_catalog_sync_receipts (workspace_id, store_id, completed_at DESC);
