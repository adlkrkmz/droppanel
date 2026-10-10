-- Registration fields + product access PENDING status. Apply manually via psql.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_name TEXT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS requested_product TEXT NULL;

DO $$
BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_requested_product_check
    CHECK (requested_product IS NULL OR requested_product IN ('EBAY', 'ETSY'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE user_product_access
    DROP CONSTRAINT IF EXISTS user_product_access_status_check;
  ALTER TABLE user_product_access
    ADD CONSTRAINT user_product_access_status_check
    CHECK (status IN ('ACTIVE', 'TRIAL', 'DISABLED', 'PENDING'));
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END $$;
