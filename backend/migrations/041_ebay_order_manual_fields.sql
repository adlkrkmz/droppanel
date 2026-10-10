-- Local manual operation fields on ebay_orders + lightweight order event log.
-- Idempotent / safe: no data deletion. These columns are NEVER written by the
-- eBay sync upsert (ordersRepository upsert lists only eBay-owned columns), so
-- manual data is preserved across syncs.

ALTER TABLE ebay_orders
  ADD COLUMN IF NOT EXISTS notes                 TEXT NULL,
  ADD COLUMN IF NOT EXISTS amazon_order_number   TEXT NULL,
  ADD COLUMN IF NOT EXISTS amazon_order_url      TEXT NULL,
  ADD COLUMN IF NOT EXISTS amazon_purchase_price NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS manual_updated_at     TIMESTAMPTZ NULL;

-- Minimal order event log (start simple; not a full event system).
CREATE TABLE IF NOT EXISTS ebay_order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES ebay_orders(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  message     TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ebay_order_events_order
  ON ebay_order_events (order_id, created_at DESC);
