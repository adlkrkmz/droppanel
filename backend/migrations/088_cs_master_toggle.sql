-- Store-scoped master switch for all Customer Service automations.
-- Default OFF. Does not enable existing stores.

CREATE TABLE IF NOT EXISTS customer_service_store_settings (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id     INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, store_id)
);
