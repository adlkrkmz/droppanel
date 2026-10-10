-- Last-known host telemetry on scan worker heartbeat (no history table).
ALTER TABLE amazon_scan_worker_heartbeat
  ADD COLUMN IF NOT EXISTS host_telemetry JSONB NULL;

CREATE INDEX IF NOT EXISTS idx_amazon_scan_jobs_completed_at
  ON amazon_scan_jobs (completed_at DESC)
  WHERE status = 'COMPLETED';

CREATE INDEX IF NOT EXISTS idx_amazon_scan_jobs_worker_completed
  ON amazon_scan_jobs (worker_id, completed_at DESC)
  WHERE status = 'COMPLETED';
