-- Desktop Agent pairing codes (one-time, hashed, 10-minute expiry).
-- Additive. Does not alter observation / Stock Guard / Public Worker paths.

CREATE TABLE IF NOT EXISTS desktop_agent_pairings (
  id                 BIGSERIAL PRIMARY KEY,
  code_hash          TEXT NOT NULL,
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at         TIMESTAMPTZ NOT NULL,
  claimed_at         TIMESTAMPTZ NULL,
  claimed_device_id  TEXT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_desktop_agent_pairings_code_hash UNIQUE (code_hash)
);

CREATE INDEX IF NOT EXISTS idx_desktop_agent_pairings_workspace_created
  ON desktop_agent_pairings (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_desktop_agent_pairings_expires
  ON desktop_agent_pairings (expires_at)
  WHERE claimed_at IS NULL;
