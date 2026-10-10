BEGIN;

-- Etsy-only durable listing ↔ draft ↔ supplier mapping (Phase 4.0.2).
-- Does not touch eBay tables. Monitor columns are placeholders only.

CREATE TABLE IF NOT EXISTS etsy_listing_sources (
  id                        BIGSERIAL PRIMARY KEY,
  workspace_id              UUID NOT NULL REFERENCES workspaces(id),
  etsy_account_id           BIGINT NOT NULL,
  shop_id                   BIGINT NOT NULL,
  listing_id                BIGINT NOT NULL,
  draft_id                  TEXT,
  supplier_platform         TEXT,
  supplier_url              TEXT,
  supplier_product_id       TEXT,
  supplier_variant          TEXT,
  supplier_title            TEXT,
  source_price              NUMERIC(12, 2),
  source_currency           TEXT,
  last_checked_at           TIMESTAMPTZ,
  last_successful_check_at  TIMESTAMPTZ,
  monitor_status            TEXT,
  monitor_error             TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, shop_id, listing_id)
);

CREATE INDEX IF NOT EXISTS etsy_listing_sources_workspace_id_idx
  ON etsy_listing_sources (workspace_id);

CREATE INDEX IF NOT EXISTS etsy_listing_sources_shop_listing_idx
  ON etsy_listing_sources (workspace_id, shop_id, listing_id);

CREATE INDEX IF NOT EXISTS etsy_listing_sources_account_idx
  ON etsy_listing_sources (workspace_id, etsy_account_id);

COMMIT;
