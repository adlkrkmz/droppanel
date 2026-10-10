-- Extension capture item lease columns for background auto-capture worker

ALTER TABLE extension_capture_items
  ADD COLUMN IF NOT EXISTS worker_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS capture_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_capture_started_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_ext_capture_items_claim
  ON extension_capture_items (status, lease_expires_at, id)
  WHERE status IN ('capture_pending', 'capturing');
