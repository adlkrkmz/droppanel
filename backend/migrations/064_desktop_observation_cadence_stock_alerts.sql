-- Desktop observation cadence + Stock Alert source separation.
-- Additive only: keeps existing review rows and protection history intact.

ALTER TABLE stock_review_items
  ADD COLUMN IF NOT EXISTS verification_source TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_review_items_verification_source
  ON stock_review_items (workspace_id, verification_source, review_status);
