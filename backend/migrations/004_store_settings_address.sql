-- Add merchant location (address) columns to store_settings for Settings page
BEGIN;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS address_first_name TEXT;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS address_last_name  TEXT;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS address_company    TEXT;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS address_line1     TEXT;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS address_line2     TEXT;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS address_city      TEXT;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS address_state     TEXT;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS address_zip       TEXT;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS address_country   TEXT;
COMMIT;
