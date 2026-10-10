BEGIN;

-- UNIQUE (asin, store_code) — ON CONFLICT için (PostgreSQL'de ADD CONSTRAINT IF NOT EXISTS yok)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'variation_products'
      AND c.conname = 'variation_products_asin_store_unique'
  ) THEN
    ALTER TABLE variation_products
      ADD CONSTRAINT variation_products_asin_store_unique UNIQUE (asin, store_code);
  END IF;
END $$;

ALTER TABLE variation_items
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

COMMIT;
