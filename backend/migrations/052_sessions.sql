-- DB-backed opaque browser sessions. Non-destructive; apply before deploying Phase 1.3 code.
CREATE TABLE IF NOT EXISTS sessions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash             TEXT NOT NULL UNIQUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at             TIMESTAMPTZ NOT NULL,
  last_seen_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at             TIMESTAMPTZ NULL,
  revoked_reason         TEXT NULL,
  ip_address             TEXT NULL,
  user_agent             TEXT NULL,
  created_by_auth_method TEXT NOT NULL DEFAULT 'password'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_revoked_at ON sessions (revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions (user_id, revoked_at, expires_at);
