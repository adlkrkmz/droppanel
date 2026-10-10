-- Durable, token-free evidence for price mutation attempts.  Written by the
-- price-update path only; receipt failures must never change mutation outcome.
CREATE TABLE IF NOT EXISTS ebay_price_mutation_receipts (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id BIGINT NULL REFERENCES stores(id) ON DELETE SET NULL,
  account_store_code TEXT NULL,
  ebay_item_id TEXT NULL,
  sku TEXT NULL,
  offer_id TEXT NULL,
  target_price NUMERIC(12,2) NOT NULL,
  mutation_method TEXT NOT NULL,
  endpoint TEXT NULL,
  http_status INTEGER NULL,
  ebay_error_code TEXT NULL,
  ebay_error_category TEXT NULL,
  ebay_error_message TEXT NULL,
  bulk_item_result JSONB NULL,
  correlation_id TEXT NULL,
  trading_price_before NUMERIC(12,2) NULL,
  trading_price_after NUMERIC(12,2) NULL,
  verified_at TIMESTAMPTZ NULL,
  final_outcome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ebay_price_mutation_receipts_listing_created
  ON ebay_price_mutation_receipts (workspace_id, ebay_item_id, created_at DESC);
