-- Alert-only anomaly detector state. This table is never read by mutation code.
CREATE TABLE IF NOT EXISTS zero_stock_alert_state (
  alert_key TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at TIMESTAMPTZ NULL,
  cooldown_until TIMESTAMPTZ NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_oxylabs_apply_operations_zero_stock_alert_window
  ON oxylabs_apply_operations (applied_at DESC)
  WHERE action = 'zero_stock' AND status = 'APPLIED';

CREATE INDEX IF NOT EXISTS idx_oxylabs_apply_operations_zero_stock_failure_window
  ON oxylabs_apply_operations (updated_at DESC)
  WHERE action = 'zero_stock' AND status IN ('RETRYABLE', 'FAILED');
