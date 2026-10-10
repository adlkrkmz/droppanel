BEGIN;
ALTER TABLE variation_products
  ADD COLUMN IF NOT EXISTS ai_title TEXT,
  ADD COLUMN IF NOT EXISTS ai_description TEXT,
  ADD COLUMN IF NOT EXISTS ai_item_specifics JSONB;
COMMIT;
