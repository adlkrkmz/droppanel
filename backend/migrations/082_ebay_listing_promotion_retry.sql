-- Bounded promotion-only retry after new-listing Marketing visibility delay.
ALTER TABLE ebay_listing_promotions
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_ebay_listing_promotions_due_retry
  ON ebay_listing_promotions (next_attempt_at)
  WHERE status = 'PENDING' AND next_attempt_at IS NOT NULL;
