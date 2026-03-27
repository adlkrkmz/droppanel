ALTER TABLE store_settings
  ADD COLUMN IF NOT EXISTS registration_country VARCHAR(16);
