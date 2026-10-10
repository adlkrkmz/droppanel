-- Workspace-scoped key/value preferences (pool category prefs, etc.)

CREATE TABLE IF NOT EXISTS workspace_preferences (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  value        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_preferences_workspace_key
  ON workspace_preferences (workspace_id, key);
