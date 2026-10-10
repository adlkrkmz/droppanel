-- eBay orders: persistent order operation store (DB-backed orders screen)
-- Idempotent / safe: no data deletion. Only eBay-owned columns are upserted by sync;
-- future local operation columns (Amazon order no, Aqualine code, credit, profit) can be
-- added later and will NOT be overwritten by the sync upsert.

CREATE TABLE IF NOT EXISTS ebay_orders (
  id                  BIGSERIAL PRIMARY KEY,
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id            INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  store_code          TEXT NOT NULL,
  ebay_order_id       TEXT NOT NULL,
  legacy_order_id     TEXT NULL,
  buyer_username      TEXT NULL,
  buyer_name          TEXT NULL,
  order_created_at    TIMESTAMPTZ NULL,
  order_updated_at    TIMESTAMPTZ NULL,
  order_status        TEXT NULL,
  fulfillment_status  TEXT NULL,
  payment_status      TEXT NULL,
  total_amount        NUMERIC NULL,
  currency            TEXT NULL,
  raw_ebay_order_json JSONB NULL,
  last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ebay_orders_ws_store_order
  ON ebay_orders (workspace_id, store_id, ebay_order_id);

CREATE INDEX IF NOT EXISTS idx_ebay_orders_ws_store_created
  ON ebay_orders (workspace_id, store_id, order_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ebay_orders_ws_created
  ON ebay_orders (workspace_id, order_created_at DESC);

CREATE TABLE IF NOT EXISTS ebay_order_items (
  id                      BIGSERIAL PRIMARY KEY,
  order_id                BIGINT NOT NULL REFERENCES ebay_orders(id) ON DELETE CASCADE,
  workspace_id            UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ebay_order_id           TEXT NOT NULL,
  -- Stable per-line key: COALESCE(lineItemId, itemId, title) — drives upsert uniqueness.
  line_key                TEXT NOT NULL,
  ebay_line_item_id       TEXT NULL,
  ebay_item_id            TEXT NULL,
  sku                     TEXT NULL,
  asin                    TEXT NULL,
  title                   TEXT NULL,
  quantity                INTEGER NULL,
  item_price              NUMERIC NULL,
  currency                TEXT NULL,
  image_url               TEXT NULL,
  matched_catalog_state_id BIGINT NULL,
  raw_ebay_line_item_json JSONB NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ebay_order_items_order_line
  ON ebay_order_items (order_id, line_key);

CREATE INDEX IF NOT EXISTS idx_ebay_order_items_order
  ON ebay_order_items (order_id);

-- Per-store last successful sync watermark (incremental sync window).
CREATE TABLE IF NOT EXISTS ebay_order_sync_state (
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id       INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  last_synced_at TIMESTAMPTZ NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, store_id)
);
