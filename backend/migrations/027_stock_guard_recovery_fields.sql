-- Stock Guard stale job recovery (non-destructive). Run manually via psql.

ALTER TABLE stock_guard_scan_jobs
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_recovered_at TIMESTAMPTZ NULL;
