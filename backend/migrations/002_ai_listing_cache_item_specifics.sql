-- Add item_specifics JSONB to ai_listing_cache for eBay item specifics map
BEGIN;
ALTER TABLE ai_listing_cache ADD COLUMN IF NOT EXISTS item_specifics JSONB;
COMMIT;
