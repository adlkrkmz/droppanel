-- Idempotent apply outbox: one pending/done row per completed scan job.
CREATE UNIQUE INDEX IF NOT EXISTS uq_amazon_scan_apply_outbox_job
  ON amazon_scan_apply_outbox (job_id);
