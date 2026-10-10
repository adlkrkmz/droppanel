-- FAZ Stock Guard v2: Keepa radar candidate + verified source + activity feed.
-- Additive. Does not alter eBay publish, OAuth, or capture-queue tables.

ALTER TABLE amazon_price_verification_tasks
  DROP CONSTRAINT IF EXISTS chk_amazon_verification_reason;

ALTER TABLE amazon_price_verification_tasks
  ADD CONSTRAINT chk_amazon_verification_reason CHECK (reason IN (
    'PRICE_AMBIGUOUS',
    'KEEPA_PRODUCT_UNRESOLVED',
    'KEEPA_UNRESOLVED',
    'ADMIN_TEST',
    'PRICE_CHANGED',
    'PRICE_MISSING',
    'FBA_SIGNAL_LOST',
    'FBM_ONLY',
    'SOURCE_STALE'
  ));

ALTER TABLE global_keepa_snapshots
  ADD COLUMN IF NOT EXISTS amazon_price NUMERIC(12,2) NULL;

ALTER TABLE global_keepa_snapshots
  ADD COLUMN IF NOT EXISTS candidate_price NUMERIC(12,2) NULL;

ALTER TABLE global_keepa_snapshots
  ADD COLUMN IF NOT EXISTS signal_class TEXT NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS last_verified_source_price NUMERIC(12,2) NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS last_verified_decision TEXT NULL;

ALTER TABLE store_catalog_state
  ADD COLUMN IF NOT EXISTS last_verified_asin TEXT NULL;

CREATE TABLE IF NOT EXISTS workspace_activity_events (
  id               BIGSERIAL PRIMARY KEY,
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id         BIGINT NULL REFERENCES stores(id) ON DELETE SET NULL,
  user_id          UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  event_type       TEXT NOT NULL,
  severity         TEXT NOT NULL DEFAULT 'info',
  title            TEXT NOT NULL,
  message          TEXT NOT NULL,
  entity_type      TEXT NULL,
  entity_id        TEXT NULL,
  catalog_state_id BIGINT NULL,
  asin             TEXT NULL,
  ebay_item_id     TEXT NULL,
  before_data      JSONB NULL,
  after_data       JSONB NULL,
  source           TEXT NOT NULL DEFAULT 'stock_guard_v2',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  visible_until    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  read_at          TIMESTAMPTZ NULL,
  CONSTRAINT chk_activity_severity CHECK (severity IN ('info', 'warning', 'error', 'success'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_activity_ws_created
  ON workspace_activity_events (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_activity_ws_unread
  ON workspace_activity_events (workspace_id, visible_until)
  WHERE read_at IS NULL;
