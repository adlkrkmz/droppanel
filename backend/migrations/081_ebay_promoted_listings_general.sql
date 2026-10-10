-- eBay Promoted Listings General (CPS) — store campaign + listing ads.
-- Default off. No backfill of existing listings.

CREATE TABLE IF NOT EXISTS ebay_promoted_campaigns (
  id                 BIGSERIAL PRIMARY KEY,
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id           BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  marketplace        TEXT NOT NULL DEFAULT 'EBAY_US',
  campaign_id        TEXT NOT NULL,
  campaign_name      TEXT NOT NULL,
  strategy           TEXT NOT NULL DEFAULT 'GENERAL',
  funding_model      TEXT NOT NULL DEFAULT 'COST_PER_SALE',
  status             TEXT NOT NULL DEFAULT 'ACTIVE',
  last_verified_at   TIMESTAMPTZ NULL,
  last_error_code    TEXT NULL,
  last_error_message TEXT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, store_id, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_ebay_promoted_campaigns_store
  ON ebay_promoted_campaigns (workspace_id, store_id);

CREATE TABLE IF NOT EXISTS ebay_listing_promotions (
  id                 BIGSERIAL PRIMARY KEY,
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id           BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  catalog_state_id   BIGINT NULL REFERENCES store_catalog_state(id) ON DELETE SET NULL,
  ebay_listing_id    TEXT NOT NULL,
  requested          BOOLEAN NOT NULL DEFAULT FALSE,
  requested_rate     NUMERIC(6,2) NULL,
  effective_rate     NUMERIC(6,2) NULL,
  campaign_id        TEXT NULL,
  ad_id              TEXT NULL,
  status             TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_error_code    TEXT NULL,
  last_error_message TEXT NULL,
  last_verified_at   TIMESTAMPTZ NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_id, ebay_listing_id),
  CONSTRAINT ebay_listing_promotions_status_chk
    CHECK (status IN ('OFF', 'PENDING', 'ACTIVE', 'FAILED', 'UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS idx_ebay_listing_promotions_workspace_store
  ON ebay_listing_promotions (workspace_id, store_id);

CREATE INDEX IF NOT EXISTS idx_ebay_listing_promotions_catalog
  ON ebay_listing_promotions (catalog_state_id)
  WHERE catalog_state_id IS NOT NULL;

ALTER TABLE extension_capture_commands
  ADD COLUMN IF NOT EXISTS promoted_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE extension_capture_commands
  ADD COLUMN IF NOT EXISTS promoted_ad_rate NUMERIC(6,2) NULL;

ALTER TABLE scheduled_publish_jobs
  ADD COLUMN IF NOT EXISTS promoted_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE scheduled_publish_jobs
  ADD COLUMN IF NOT EXISTS promoted_ad_rate NUMERIC(6,2) NULL;
