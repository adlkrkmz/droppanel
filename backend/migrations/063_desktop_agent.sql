-- Desktop Agent Phase 2: device registry + observation audit counters.
-- Additive. Does not alter Stock Guard business rules or Public Worker tables.

CREATE TABLE IF NOT EXISTS desktop_agent_devices (
  id                 BIGSERIAL PRIMARY KEY,
  device_id          TEXT NOT NULL,
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name        TEXT NOT NULL DEFAULT 'Desktop Agent',
  token_hash         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'ONLINE',
  version            TEXT NULL,
  last_heartbeat_at  TIMESTAMPTZ NULL,
  last_observation_at TIMESTAMPTZ NULL,
  scanned_count      INTEGER NOT NULL DEFAULT 0,
  success_count_today INTEGER NOT NULL DEFAULT 0,
  failure_count_today INTEGER NOT NULL DEFAULT 0,
  success_day        DATE NULL,
  failure_day        DATE NULL,
  metrics_json       JSONB NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_desktop_agent_devices_device UNIQUE (device_id),
  CONSTRAINT uq_desktop_agent_devices_token_hash UNIQUE (token_hash),
  CONSTRAINT chk_desktop_agent_devices_status CHECK (status IN ('ONLINE', 'OFFLINE', 'REVOKED'))
);

CREATE INDEX IF NOT EXISTS idx_desktop_agent_devices_workspace
  ON desktop_agent_devices (workspace_id, user_id, last_heartbeat_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS desktop_agent_observation_events (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id       TEXT NOT NULL,
  asin            TEXT NOT NULL,
  catalog_state_id BIGINT NULL,
  task_id         BIGINT NULL,
  event_kind      TEXT NOT NULL,
  public_status   TEXT NULL,
  decision_code   TEXT NULL,
  error_code      TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_desktop_agent_obs_kind CHECK (event_kind IN ('SUCCESS', 'TECHNICAL_FAILURE', 'REJECTED'))
);

CREATE INDEX IF NOT EXISTS idx_desktop_agent_obs_workspace_day
  ON desktop_agent_observation_events (workspace_id, created_at DESC);

-- Allow desktop-initiated verification tasks.
ALTER TABLE amazon_price_verification_tasks
  DROP CONSTRAINT IF EXISTS chk_amazon_verification_reason;

ALTER TABLE amazon_price_verification_tasks
  ADD CONSTRAINT chk_amazon_verification_reason CHECK (reason IN (
    'PRICE_AMBIGUOUS',
    'KEEPA_PRODUCT_UNRESOLVED',
    'KEEPA_UNRESOLVED',
    'ADMIN_TEST',
    'PRICE_CHANGED',
    'PRICE_MISSING',
    'FBA_SIGNAL_LOST',
    'FBM_ONLY',
    'SOURCE_STALE',
    'DESKTOP_AGENT'
  ));
