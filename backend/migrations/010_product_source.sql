ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'amazon';
ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS external_id TEXT;
