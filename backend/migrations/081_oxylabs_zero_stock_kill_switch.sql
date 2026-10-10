CREATE TABLE IF NOT EXISTS oxylabs_zero_stock_kill_switch (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  reserved_slots INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  triggered_at TIMESTAMPTZ NULL,
  last_reset_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO oxylabs_zero_stock_kill_switch (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;
