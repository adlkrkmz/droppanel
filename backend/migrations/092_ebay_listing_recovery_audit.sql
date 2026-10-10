CREATE TABLE IF NOT EXISTS ebay_listing_recovery_runs (
  recovery_id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id), store_id BIGINT NOT NULL REFERENCES stores(id),
  incident_timestamp TIMESTAMPTZ NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('dry-run','execute')), status TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0, snapshot_count INTEGER NOT NULL DEFAULT 0, manifest_count INTEGER NOT NULL DEFAULT 0,
  execution_ready_count INTEGER NOT NULL DEFAULT 0, stale_changed_count INTEGER NOT NULL DEFAULT 0, remote_receipt_id BIGINT NULL REFERENCES ebay_catalog_sync_receipts(id),
  rows_restored INTEGER NOT NULL DEFAULT 0, rows_skipped INTEGER NOT NULL DEFAULT 0, rows_failed INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NULL, error_summary TEXT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS ebay_listing_recovery_snapshot (
  recovery_id UUID NOT NULL REFERENCES ebay_listing_recovery_runs(recovery_id), catalog_row_id BIGINT NOT NULL, store_id BIGINT NOT NULL,
  ebay_item_id TEXT NOT NULL, asin TEXT NULL, current_status TEXT NOT NULL, ebay_quantity INTEGER NULL, panel_hidden_at TIMESTAMPTZ NOT NULL,
  last_seen_ended_at TIMESTAMPTZ NULL, last_seen_live_at TIMESTAMPTZ NULL, last_sync_at TIMESTAMPTZ NULL, updated_at TIMESTAMPTZ NULL, snapshot_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(recovery_id,catalog_row_id)
);
CREATE TABLE IF NOT EXISTS ebay_listing_recovery_manifest (
  recovery_id UUID NOT NULL REFERENCES ebay_listing_recovery_runs(recovery_id), catalog_row_id BIGINT NOT NULL, ebay_item_id TEXT NOT NULL, asin TEXT NULL,
  snapshot_status TEXT NOT NULL, snapshot_local_quantity INTEGER NULL, snapshot_panel_hidden_at TIMESTAMPTZ NOT NULL,
  remote_classification TEXT NOT NULL, remote_quantity INTEGER NULL, would_restore BOOLEAN NOT NULL, exclusion_reason TEXT NULL, stale_state BOOLEAN NOT NULL DEFAULT false, manifest_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(recovery_id,catalog_row_id)
);
CREATE INDEX IF NOT EXISTS idx_ebay_listing_recovery_runs_store ON ebay_listing_recovery_runs(workspace_id,store_id,created_at DESC);
