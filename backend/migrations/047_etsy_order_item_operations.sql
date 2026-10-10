BEGIN;

-- Etsy-only transaction-level fulfillment operations (Phase 4.0.6).
-- Does not store customer/address/payment/variation/personalization data.
-- Etsy receipts remain the source of truth via live API reads.

CREATE TABLE IF NOT EXISTS etsy_order_item_operations (
  id                        BIGSERIAL PRIMARY KEY,
  workspace_id              UUID NOT NULL REFERENCES workspaces(id),
  etsy_account_id           BIGINT NOT NULL,
  shop_id                   BIGINT NOT NULL,
  receipt_id                BIGINT NOT NULL,
  transaction_id            BIGINT NOT NULL,
  listing_id                BIGINT,
  listing_source_id         BIGINT,
  workflow_status           TEXT NOT NULL DEFAULT 'new',
  supplier_order_id         TEXT,
  supplier_order_url        TEXT,
  supplier_order_status     TEXT,
  purchase_cost             NUMERIC(12, 2),
  purchase_currency         TEXT,
  expected_delivery_at      TIMESTAMPTZ,
  supplier_shipped_at       TIMESTAMPTZ,
  supplier_delivered_at     TIMESTAMPTZ,
  tracking_carrier          TEXT,
  tracking_code             TEXT,
  tracking_url              TEXT,
  tracking_captured_at      TIMESTAMPTZ,
  issue_code                TEXT,
  internal_note             TEXT,
  purchased_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, shop_id, receipt_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS etsy_order_item_ops_workspace_idx
  ON etsy_order_item_operations (workspace_id);

CREATE INDEX IF NOT EXISTS etsy_order_item_ops_shop_receipt_idx
  ON etsy_order_item_operations (workspace_id, shop_id, receipt_id);

CREATE INDEX IF NOT EXISTS etsy_order_item_ops_account_idx
  ON etsy_order_item_operations (workspace_id, etsy_account_id);

CREATE INDEX IF NOT EXISTS etsy_order_item_ops_status_idx
  ON etsy_order_item_operations (workspace_id, shop_id, workflow_status);

COMMIT;
