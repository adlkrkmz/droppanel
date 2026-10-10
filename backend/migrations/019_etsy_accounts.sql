BEGIN;

CREATE TYPE etsy_account_status AS ENUM (
  'CONNECTED',
  'EXPIRED',
  'ERROR',
  'DISCONNECTED',
  'REMOVED'
);

CREATE TABLE IF NOT EXISTS etsy_accounts (
  id                      BIGSERIAL PRIMARY KEY,
  workspace_id            UUID NOT NULL REFERENCES workspaces(id),
  etsy_user_id            BIGINT NOT NULL,
  shop_id                 BIGINT NOT NULL,
  shop_name               TEXT,
  shop_url                TEXT,
  access_token_encrypted  TEXT,
  refresh_token_encrypted TEXT,
  token_type              TEXT NOT NULL DEFAULT 'Bearer',
  expires_at              TIMESTAMPTZ,
  scopes                  TEXT,
  status                  etsy_account_status NOT NULL DEFAULT 'DISCONNECTED',
  last_connected_at       TIMESTAMPTZ,
  last_refreshed_at       TIMESTAMPTZ,
  last_tested_at          TIMESTAMPTZ,
  last_error              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at              TIMESTAMPTZ,
  UNIQUE (workspace_id, shop_id)
);

CREATE INDEX IF NOT EXISTS etsy_accounts_workspace_id_idx ON etsy_accounts (workspace_id);
CREATE INDEX IF NOT EXISTS etsy_accounts_status_idx ON etsy_accounts (status);
CREATE INDEX IF NOT EXISTS etsy_accounts_expires_at_idx ON etsy_accounts (expires_at);

COMMIT;
