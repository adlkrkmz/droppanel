BEGIN;

-- Etsy-only panel product drafts (ChatGPT + panel builder canonical store).
-- Does not touch eBay tables. Soft-delete via deleted_at.

CREATE TABLE IF NOT EXISTS etsy_panel_drafts (
  id                    BIGSERIAL PRIMARY KEY,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id),
  draft_id              TEXT NOT NULL,
  shop_id               TEXT NOT NULL,
  etsy_account_id       BIGINT,
  shop_name             TEXT,
  payload               JSONB NOT NULL,
  supplier_url          TEXT,
  supplier_platform     TEXT,
  selected_variation_key TEXT,
  idempotency_key       TEXT,
  source                TEXT NOT NULL DEFAULT 'panel',
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ,
  UNIQUE (workspace_id, draft_id)
);

-- Idempotency is unique only when key is present (NULLs allowed multiple times).
CREATE UNIQUE INDEX IF NOT EXISTS etsy_panel_drafts_idempotency_uidx
  ON etsy_panel_drafts (workspace_id, shop_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS etsy_panel_drafts_shop_updated_idx
  ON etsy_panel_drafts (workspace_id, shop_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS etsy_panel_drafts_supplier_url_idx
  ON etsy_panel_drafts (workspace_id, supplier_url)
  WHERE deleted_at IS NULL AND supplier_url IS NOT NULL;

COMMIT;
