-- 062: Migrate tiered_profit_overrides from legacy $10-bucket map to manual range arrays.
-- Empty TIERED stores get the previous UI defaults ($0–9.99 … $90–99.99) so pricing stays stable.
-- PERCENTAGE stores with empty maps become [].
-- Non-empty legacy maps become inclusive $10 ranges (start … start+9.99).

DO $$
DECLARE
  default_ranges jsonb := '[
    {"minPrice":0,"maxPrice":9.99,"minNetProfit":2},
    {"minPrice":10,"maxPrice":19.99,"minNetProfit":4},
    {"minPrice":20,"maxPrice":29.99,"minNetProfit":6},
    {"minPrice":30,"maxPrice":39.99,"minNetProfit":8},
    {"minPrice":40,"maxPrice":49.99,"minNetProfit":10},
    {"minPrice":50,"maxPrice":59.99,"minNetProfit":12},
    {"minPrice":60,"maxPrice":69.99,"minNetProfit":14},
    {"minPrice":70,"maxPrice":79.99,"minNetProfit":16},
    {"minPrice":80,"maxPrice":89.99,"minNetProfit":18},
    {"minPrice":90,"maxPrice":99.99,"minNetProfit":20}
  ]'::jsonb;
  r RECORD;
  k TEXT;
  start_n NUMERIC;
  profit_n NUMERIC;
  ranges jsonb;
  entry jsonb;
BEGIN
  FOR r IN
    SELECT store_id, pricing_mode, tiered_profit_overrides
    FROM store_settings
    WHERE jsonb_typeof(tiered_profit_overrides) = 'object'
  LOOP
    IF r.tiered_profit_overrides = '{}'::jsonb THEN
      IF r.pricing_mode = 'TIERED_MIN_NET_PROFIT' THEN
        UPDATE store_settings
        SET tiered_profit_overrides = default_ranges,
            updated_at = NOW()
        WHERE store_id = r.store_id;
      ELSE
        UPDATE store_settings
        SET tiered_profit_overrides = '[]'::jsonb,
            updated_at = NOW()
        WHERE store_id = r.store_id;
      END IF;
      CONTINUE;
    END IF;

    ranges := '[]'::jsonb;
    FOR k, profit_n IN
      SELECT key, value::text::numeric
      FROM jsonb_each(r.tiered_profit_overrides)
    LOOP
      start_n := FLOOR(k::numeric / 10) * 10;
      entry := jsonb_build_object(
        'minPrice', start_n,
        'maxPrice', ROUND((start_n + 9.99)::numeric, 2),
        'minNetProfit', ROUND(profit_n::numeric, 2)
      );
      ranges := ranges || jsonb_build_array(entry);
    END LOOP;

    UPDATE store_settings
    SET tiered_profit_overrides = ranges,
        updated_at = NOW()
    WHERE store_id = r.store_id;
  END LOOP;
END $$;

COMMENT ON COLUMN store_settings.tiered_profit_overrides IS
  'JSON array of {minPrice,maxPrice,minNetProfit}. Legacy $10-bucket maps were migrated in 062.';
