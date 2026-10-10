-- Store-bound Gmail mailbox + transactional email ingest (Phase 1).
-- Does not rewrite ebay_orders sync columns. Additive only.

CREATE TABLE IF NOT EXISTS mailbox_accounts (
  id                    BIGSERIAL PRIMARY KEY,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id              INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL DEFAULT 'gmail',
  email_address         TEXT NOT NULL,
  provider_account_id   TEXT NOT NULL,
  access_token_enc      TEXT NOT NULL,
  refresh_token_enc     TEXT NOT NULL,
  token_expires_at      TIMESTAMPTZ NULL,
  scope                 TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'CONNECTED',
  history_id            TEXT NULL,
  last_ingested_at      TIMESTAMPTZ NULL,
  last_error            TEXT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mailbox_accounts_provider CHECK (provider = 'gmail'),
  CONSTRAINT chk_mailbox_accounts_status CHECK (status IN (
    'CONNECTED', 'DISCONNECTED', 'ERROR', 'NEEDS_REAUTH'
  )),
  CONSTRAINT uq_mailbox_accounts_store UNIQUE (workspace_id, store_id),
  CONSTRAINT uq_mailbox_accounts_provider_account UNIQUE (provider, provider_account_id)
);

CREATE INDEX IF NOT EXISTS idx_mailbox_accounts_status
  ON mailbox_accounts (status, last_ingested_at);

CREATE TABLE IF NOT EXISTS mailbox_messages (
  id                      BIGSERIAL PRIMARY KEY,
  workspace_id            UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id                INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  mailbox_account_id      BIGINT NOT NULL REFERENCES mailbox_accounts(id) ON DELETE CASCADE,
  provider_message_id     TEXT NOT NULL,
  rfc_message_id          TEXT NULL,
  thread_id               TEXT NULL,
  sender                  TEXT NULL,
  recipient               TEXT NULL,
  subject                 TEXT NULL,
  received_at             TIMESTAMPTZ NULL,
  text_body               TEXT NULL,
  html_body               TEXT NULL,
  attachment_meta         JSONB NOT NULL DEFAULT '[]'::jsonb,
  inline_image_meta       JSONB NOT NULL DEFAULT '[]'::jsonb,
  classified_type         TEXT NULL,
  parsed_payload          JSONB NULL,
  processing_status       TEXT NOT NULL DEFAULT 'PENDING',
  review_reason           TEXT NULL,
  matched_ebay_order_pk   BIGINT NULL REFERENCES ebay_orders(id) ON DELETE SET NULL,
  processed_at            TIMESTAMPTZ NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mailbox_messages_status CHECK (processing_status IN (
    'PENDING', 'PROCESSED', 'IGNORED', 'NEEDS_REVIEW', 'FAILED'
  )),
  CONSTRAINT uq_mailbox_messages_provider_id UNIQUE (mailbox_account_id, provider_message_id)
);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_pending
  ON mailbox_messages (mailbox_account_id, processing_status, received_at DESC);

CREATE TABLE IF NOT EXISTS mailbox_link_reviews (
  id                    BIGSERIAL PRIMARY KEY,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id              INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  mailbox_message_id    BIGINT NOT NULL REFERENCES mailbox_messages(id) ON DELETE CASCADE,
  amazon_order_number   TEXT NULL,
  candidate_order_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'OPEN',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mailbox_link_reviews_status CHECK (status IN ('OPEN', 'RESOLVED', 'IGNORED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mailbox_link_reviews_open_msg
  ON mailbox_link_reviews (mailbox_message_id)
  WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS mailbox_store_payouts (
  id                    BIGSERIAL PRIMARY KEY,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id              INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  mailbox_message_id    BIGINT NOT NULL REFERENCES mailbox_messages(id) ON DELETE CASCADE,
  payout_id             TEXT NOT NULL,
  amount                NUMERIC(12, 2) NULL,
  currency              TEXT NULL,
  destination           TEXT NULL,
  payout_type           TEXT NULL,
  payout_date           TEXT NULL,
  estimated_arrival     TEXT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mailbox_store_payouts UNIQUE (workspace_id, store_id, payout_id)
);

ALTER TABLE ebay_order_events
  ADD COLUMN IF NOT EXISTS source_mailbox_message_id BIGINT NULL REFERENCES mailbox_messages(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ebay_order_events_mailbox_type
  ON ebay_order_events (order_id, event_type, source_mailbox_message_id)
  WHERE source_mailbox_message_id IS NOT NULL;

ALTER TABLE ebay_orders
  ADD COLUMN IF NOT EXISTS amazon_purchase_currency TEXT NULL,
  ADD COLUMN IF NOT EXISTS amazon_cost_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS ebay_tracking_number TEXT NULL,
  ADD COLUMN IF NOT EXISTS ebay_tracking_carrier TEXT NULL,
  ADD COLUMN IF NOT EXISTS ebay_shipment_status TEXT NULL,
  ADD COLUMN IF NOT EXISTS ebay_shipped_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS ebay_tracking_checked_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS amazon_tracking_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS amazon_shipment_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS amazon_package_index TEXT NULL,
  ADD COLUMN IF NOT EXISTS amazon_estimated_delivery TEXT NULL,
  ADD COLUMN IF NOT EXISTS amazon_delivery_status TEXT NULL,
  ADD COLUMN IF NOT EXISTS amazon_delivery_location TEXT NULL,
  ADD COLUMN IF NOT EXISTS amazon_delivered_at TIMESTAMPTZ NULL;
