-- Local operation status for the dropshipping flow — independent from eBay's
-- order_status / fulfillment_status / payment_status (those are NOT touched).
-- Idempotent / safe: no data deletion. Sync upsert never writes these columns,
-- so operation status survives re-sync.

ALTER TABLE ebay_orders
  ADD COLUMN IF NOT EXISTS operation_status            TEXT NULL,
  ADD COLUMN IF NOT EXISTS operation_status_updated_at TIMESTAMPTZ NULL;
