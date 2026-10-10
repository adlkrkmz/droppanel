-- eBay Notification API destination/subscription + store-scoped buyer-message events.
-- Does not alter Thank You, Gmail, or order poller tables.

CREATE TABLE IF NOT EXISTS ebay_notification_destinations (
  id BIGSERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  destination_id TEXT,
  verification_token TEXT NOT NULL,
  status TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ebay_notification_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  store_id BIGINT NOT NULL REFERENCES stores(id),
  topic_id TEXT NOT NULL,
  subscription_id TEXT,
  destination_id TEXT,
  status TEXT,
  topic_scope TEXT,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, store_id, topic_id)
);

CREATE TABLE IF NOT EXISTS ebay_notification_events (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id),
  store_id BIGINT REFERENCES stores(id),
  topic_id TEXT NOT NULL,
  notification_id TEXT,
  conversation_id TEXT,
  payload JSONB NOT NULL,
  signature_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ebay_notification_events_notification_id_uidx
  ON ebay_notification_events (notification_id)
  WHERE notification_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ebay_notification_events_store_idx
  ON ebay_notification_events (workspace_id, store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS customer_service_inbox_signals (
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  store_id BIGINT NOT NULL REFERENCES stores(id),
  unread_hint INTEGER NOT NULL DEFAULT 0,
  last_topic TEXT,
  last_event_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, store_id)
);
