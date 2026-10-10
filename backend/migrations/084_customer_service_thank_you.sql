-- Customer Service automations + Thank You send ledger.
-- Additive only. Does not change ebay_orders sync columns.

CREATE TABLE IF NOT EXISTS customer_service_automations (
  id               BIGSERIAL PRIMARY KEY,
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id         INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  automation_type  TEXT NOT NULL,
  enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  template_body    TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cs_automations_type CHECK (automation_type IN (
    'THANK_YOU', 'SHIPPED', 'DELAYED', 'DELIVERED'
  )),
  CONSTRAINT uq_cs_automations_store_type UNIQUE (workspace_id, store_id, automation_type)
);

CREATE TABLE IF NOT EXISTS customer_service_sends (
  id                 BIGSERIAL PRIMARY KEY,
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id           INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  ebay_order_id      TEXT NOT NULL,
  automation_type    TEXT NOT NULL,
  status             TEXT NOT NULL,
  template_snapshot  TEXT,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  ebay_message_id    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at            TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cs_sends_type CHECK (automation_type IN (
    'THANK_YOU', 'SHIPPED', 'DELAYED', 'DELIVERED'
  )),
  CONSTRAINT chk_cs_sends_status CHECK (status IN (
    'queued', 'pending', 'sent', 'failed', 'skipped'
  )),
  CONSTRAINT uq_cs_sends_unique UNIQUE (workspace_id, store_id, ebay_order_id, automation_type)
);

CREATE INDEX IF NOT EXISTS idx_cs_sends_queued
  ON customer_service_sends (status, created_at)
  WHERE status IN ('queued', 'pending');

CREATE INDEX IF NOT EXISTS idx_cs_sends_store_created
  ON customer_service_sends (workspace_id, store_id, created_at DESC);
