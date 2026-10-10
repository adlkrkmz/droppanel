ALTER TABLE store_settings
  ADD COLUMN IF NOT EXISTS pricing_mode TEXT NOT NULL DEFAULT 'PERCENTAGE_NET_PROFIT',
  ADD COLUMN IF NOT EXISTS percentage_net_profit_percent NUMERIC(7,2),
  ADD COLUMN IF NOT EXISTS tiered_profit_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE store_settings
SET percentage_net_profit_percent = COALESCE(percentage_net_profit_percent, markup_percent, 35.00),
    pricing_mode = COALESCE(NULLIF(pricing_mode, ''), 'PERCENTAGE_NET_PROFIT'),
    tiered_profit_overrides = COALESCE(tiered_profit_overrides, '{}'::jsonb)
WHERE percentage_net_profit_percent IS NULL
   OR pricing_mode IS NULL
   OR pricing_mode = ''
   OR tiered_profit_overrides IS NULL;

ALTER TABLE store_settings
  ALTER COLUMN percentage_net_profit_percent SET DEFAULT 35.00,
  ALTER COLUMN percentage_net_profit_percent SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'store_settings_pricing_mode_check'
  ) THEN
    ALTER TABLE store_settings
      ADD CONSTRAINT store_settings_pricing_mode_check
      CHECK (pricing_mode IN ('PERCENTAGE_NET_PROFIT', 'TIERED_MIN_NET_PROFIT'));
  END IF;
END $$;

COMMENT ON COLUMN store_settings.markup_percent IS
  'Legacy compatibility column; Pricing V2 runtime uses percentage_net_profit_percent.';
