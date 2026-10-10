-- Auto Profit Protection (non-destructive). Run manually via psql.

ALTER TABLE stock_guard_settings
  ADD COLUMN IF NOT EXISTS auto_profit_protection_enabled BOOLEAN NOT NULL DEFAULT false;
