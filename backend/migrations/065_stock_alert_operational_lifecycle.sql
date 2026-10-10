-- Stock Alert operational lifecycle and structured provenance.
-- Additive only: does not rewrite existing review/history rows.

ALTER TABLE stock_review_items
  ADD COLUMN IF NOT EXISTS operation_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS operation_key TEXT NULL,
  ADD COLUMN IF NOT EXISTS mutation_attempted BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE stock_review_items
  DROP CONSTRAINT IF EXISTS chk_stock_review_operation_type;

ALTER TABLE stock_review_items
  ADD CONSTRAINT chk_stock_review_operation_type CHECK (
    operation_type IS NULL OR operation_type IN ('VERIFICATION', 'PRICE_PROTECTION', 'STOCK_PROTECTION')
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_review_operation_key
  ON stock_review_items (workspace_id, operation_key)
  WHERE operation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_review_operational_feed
  ON stock_review_items (workspace_id, store_id, review_status, operation_type, mutation_attempted);
