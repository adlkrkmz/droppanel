-- Stock review async approve-zero (non-destructive). Run manually when ready.

ALTER TABLE stock_review_items
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS processing_job_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_review_items_ws_store_processing
  ON stock_review_items (workspace_id, store_id, review_status)
  WHERE review_status = 'processing';
