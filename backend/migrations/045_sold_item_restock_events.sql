-- Sold Item Auto Restock — idempotency / audit per order line item.
-- One row per (workspace, store, order, line item); prevents duplicate qty updates.

CREATE TABLE IF NOT EXISTS sold_item_restock_events (
  id                  BIGSERIAL PRIMARY KEY,
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id            INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  ebay_order_id       TEXT NOT NULL,
  ebay_line_item_id   TEXT NOT NULL,
  sku                 TEXT NULL,
  ebay_item_id        TEXT NULL,
  ebay_offer_id       TEXT NULL,
  catalog_state_id    BIGINT NULL,
  checked_quantity    INTEGER NULL,
  action              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'done',
  checked_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  restocked_at        TIMESTAMPTZ NULL,
  error_message       TEXT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sold_item_restock_ws_store_order_line
  ON sold_item_restock_events (workspace_id, store_id, ebay_order_id, ebay_line_item_id);

CREATE INDEX IF NOT EXISTS idx_sold_item_restock_ws_store_checked
  ON sold_item_restock_events (workspace_id, store_id, checked_at DESC);
