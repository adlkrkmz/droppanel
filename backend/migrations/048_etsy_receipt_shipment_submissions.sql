BEGIN;

-- Etsy-only receipt-level tracking submission ledger (Phase 4.0.7).
-- Does not store customer/address/variation/personalization data.
-- Unique key prevents duplicate Etsy createReceiptShipment calls.

CREATE TABLE IF NOT EXISTS etsy_receipt_shipment_submissions (
  id                         BIGSERIAL PRIMARY KEY,
  workspace_id               UUID NOT NULL REFERENCES workspaces(id),
  etsy_account_id            BIGINT NOT NULL,
  shop_id                    BIGINT NOT NULL,
  receipt_id                 BIGINT NOT NULL,

  carrier_name               TEXT NOT NULL,
  normalized_carrier_name    TEXT NOT NULL,
  tracking_code              TEXT NOT NULL,
  normalized_tracking_code   TEXT NOT NULL,
  tracking_url               TEXT,

  transaction_ids            JSONB NOT NULL DEFAULT '[]'::jsonb,
  candidate_fingerprint      TEXT NOT NULL,
  idempotency_key            TEXT NOT NULL,

  submission_status          TEXT NOT NULL DEFAULT 'prepared',
  attempt_count              INTEGER NOT NULL DEFAULT 0,

  etsy_shipment_id           BIGINT,
  etsy_receipt_shipped       BOOLEAN,
  etsy_response_verified     BOOLEAN,

  submitted_at               TIMESTAMPTZ,
  readback_verified_at       TIMESTAMPTZ,
  last_attempt_at            TIMESTAMPTZ,

  last_error_code            TEXT,
  last_error_status          INTEGER,
  last_error_message         TEXT,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workspace_id, shop_id, receipt_id, normalized_carrier_name, normalized_tracking_code),
  UNIQUE (workspace_id, shop_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS etsy_receipt_ship_subs_workspace_idx
  ON etsy_receipt_shipment_submissions (workspace_id);

CREATE INDEX IF NOT EXISTS etsy_receipt_ship_subs_receipt_idx
  ON etsy_receipt_shipment_submissions (workspace_id, shop_id, receipt_id);

CREATE INDEX IF NOT EXISTS etsy_receipt_ship_subs_status_idx
  ON etsy_receipt_shipment_submissions (workspace_id, shop_id, submission_status);

CREATE INDEX IF NOT EXISTS etsy_receipt_ship_subs_fingerprint_idx
  ON etsy_receipt_shipment_submissions (workspace_id, shop_id, candidate_fingerprint);

COMMIT;
