-- Unique Oxylabs provider-call reservation per job. Cap is COUNT(*) of this table.
-- Additive. Does not rewrite jobs, candidates, or outbox.

CREATE TABLE IF NOT EXISTS oxylabs_verify_call_reservations (
  job_id BIGINT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  worker_role TEXT NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oxylabs_verify_call_reservations_reserved_at
  ON oxylabs_verify_call_reservations (reserved_at);
