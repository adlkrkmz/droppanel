-- eBay Order earnings (Seller Hub "Order earnings") cache on ebay_orders.
-- Idempotent / safe: never written by order sync upsert (eBay-owned columns only).

ALTER TABLE ebay_orders
  ADD COLUMN IF NOT EXISTS ebay_order_earnings            NUMERIC(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS ebay_order_earnings_currency   TEXT NULL,
  ADD COLUMN IF NOT EXISTS ebay_order_earnings_source     TEXT NULL,
  ADD COLUMN IF NOT EXISTS ebay_order_earnings_checked_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS ebay_order_earnings_error      TEXT NULL;
