-- Soft archive fields for asin_pool (no data deletion, no backfill)

ALTER TABLE asin_pool
  ADD COLUMN IF NOT EXISTS archived_at    TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS archived_by    TEXT NULL,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_asin_pool_workspace_archived
  ON asin_pool (workspace_id, archived_at);

CREATE INDEX IF NOT EXISTS idx_asin_pool_workspace_stage_status_archived
  ON asin_pool (workspace_id, pipeline_stage, status, archived_at);
