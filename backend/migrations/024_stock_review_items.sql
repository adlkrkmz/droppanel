-- Stock review queue (Keepa-driven) - non-destructive.
-- Run manually via psql when ready.

CREATE TABLE IF NOT EXISTS stock_review_items (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    UUID    NOT NULL,
  store_id        BIGINT  NOT NULL,
  catalog_state_id BIGINT NOT NULL,

  ebay_item_id    TEXT NULL,
  internal_sku    TEXT NULL,
  asin            TEXT NOT NULL,
  ebay_title      TEXT NULL,
  image_url       TEXT NULL,
  ebay_quantity   INTEGER NULL,
  ebay_price      NUMERIC(12,2) NULL,

  source_status   TEXT NOT NULL,
  source_status_reason TEXT NULL,
  source_price    NUMERIC(12,2) NULL,

  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_at      TIMESTAMPTZ NULL,

  review_status   TEXT NOT NULL DEFAULT 'pending',
  approved_at     TIMESTAMPTZ NULL,
  ignored_at      TIMESTAMPTZ NULL,
  actioned_at     TIMESTAMPTZ NULL,
  action_error    TEXT NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_review_items_ws_store_status
  ON stock_review_items (workspace_id, store_id, review_status);

CREATE INDEX IF NOT EXISTS idx_stock_review_items_ws_store_asin
  ON stock_review_items (workspace_id, store_id, asin);

CREATE INDEX IF NOT EXISTS idx_stock_review_items_catalog_state
  ON stock_review_items (catalog_state_id);

CREATE INDEX IF NOT EXISTS idx_stock_review_items_ebay_item
  ON stock_review_items (ebay_item_id);

CREATE INDEX IF NOT EXISTS idx_stock_review_items_detected_at
  ON stock_review_items (detected_at DESC);

-- Dedup: same listing + same risk should not create multiple pending items.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_review_pending_dedup
  ON stock_review_items (workspace_id, store_id, catalog_state_id, source_status)
  WHERE review_status = 'pending';

