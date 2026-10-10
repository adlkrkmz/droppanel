-- Additive Amazon Browser Worker vault + heartbeat. No eBay/auth/workspace changes.

CREATE TABLE IF NOT EXISTS amazon_worker_accounts (
  id BIGSERIAL PRIMARY KEY,
  source_platform TEXT NOT NULL DEFAULT 'amazon.com',
  account_type TEXT NOT NULL DEFAULT 'PERSONAL',
  email TEXT,
  password_encrypted TEXT,
  authenticator_enabled BOOLEAN NOT NULL DEFAULT false,
  totp_secret_encrypted TEXT,
  proxy_enabled BOOLEAN NOT NULL DEFAULT false,
  proxy_host TEXT,
  proxy_port INTEGER,
  proxy_username TEXT,
  proxy_password_encrypted TEXT,
  account_status TEXT NOT NULL DEFAULT 'UNCONFIGURED',
  browser_profile_id TEXT NOT NULL DEFAULT 'default',
  last_login_at TIMESTAMPTZ,
  last_successful_verification_at TIMESTAMPTZ,
  last_error TEXT,
  session_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT amazon_worker_accounts_type_chk
    CHECK (account_type IN ('PERSONAL', 'BUSINESS')),
  CONSTRAINT amazon_worker_accounts_status_chk
    CHECK (account_status IN (
      'UNCONFIGURED','READY','ONLINE','LOGIN_REQUIRED',
      'CHALLENGE_REQUIRED','THROTTLED','PAUSED','ERROR'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS amazon_worker_accounts_singleton_idx
  ON amazon_worker_accounts ((true));

CREATE TABLE IF NOT EXISTS amazon_browser_worker_heartbeat (
  worker_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'OFFLINE',
  last_heartbeat_at TIMESTAMPTZ,
  browser_running BOOLEAN NOT NULL DEFAULT false,
  amazon_session_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  current_task_id BIGINT,
  queue_pending INTEGER,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  pause_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE amazon_price_verification_tasks
  ADD COLUMN IF NOT EXISTS claimed_by_source TEXT;

COMMENT ON TABLE amazon_worker_accounts IS
  'Platform Amazon account vault for server browser verification. Secrets are AES-256-GCM payloads.';

INSERT INTO amazon_worker_accounts (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO amazon_browser_worker_heartbeat (worker_id) VALUES ('amazon-browser-worker') ON CONFLICT (worker_id) DO NOTHING;
