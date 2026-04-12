-- eBay fiyat/stok cache (periyodik sync ile doldurulur)
ALTER TABLE store_catalog_state
ADD COLUMN IF NOT EXISTS ebay_price NUMERIC,
ADD COLUMN IF NOT EXISTS ebay_quantity INTEGER,
ADD COLUMN IF NOT EXISTS ebay_price_synced_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS ebay_title TEXT;
