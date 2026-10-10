-- Preserve Stock Alerts operational history while allowing a user-scoped feed cleanup.
ALTER TABLE stock_review_items
  ADD COLUMN IF NOT EXISTS feed_hidden_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_stock_review_items_feed_hidden
  ON stock_review_items (workspace_id, store_id, feed_hidden_at);
