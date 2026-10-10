-- Additive Oxylabs apply mutation ownership. Does not rewrite jobs, candidates, or outbox rows.

CREATE TABLE IF NOT EXISTS oxylabs_apply_operations (
  operation_key      TEXT PRIMARY KEY,
  job_id             BIGINT NOT NULL REFERENCES amazon_scan_jobs(id) ON DELETE CASCADE,
  catalog_state_id   BIGINT NOT NULL,
  action             TEXT NOT NULL,
  target             TEXT NOT NULL,
  status             TEXT NOT NULL,
  owner              TEXT NULL,
  lease_until        TIMESTAMPTZ NULL,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  ebay_mutate_count  INTEGER NOT NULL DEFAULT 0,
  ebay_readback_count INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT NULL,
  applied_at         TIMESTAMPTZ NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_oxylabs_apply_operations_action CHECK (action IN ('zero_stock', 'profit_protection')),
  CONSTRAINT chk_oxylabs_apply_operations_status CHECK (status IN (
    'CLAIMED', 'APPLIED', 'RETRYABLE', 'FAILED', 'SKIPPED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_oxylabs_apply_operations_job
  ON oxylabs_apply_operations (job_id);

CREATE INDEX IF NOT EXISTS idx_oxylabs_apply_operations_lease
  ON oxylabs_apply_operations (status, lease_until)
  WHERE status IN ('CLAIMED', 'RETRYABLE');
