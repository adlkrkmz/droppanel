-- Product access per user (EBAY | ETSY). Apply manually via psql.

CREATE TABLE IF NOT EXISTS user_product_access (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product    TEXT NOT NULL CHECK (product IN ('EBAY', 'ETSY')),
  status     TEXT NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('ACTIVE', 'TRIAL', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, product)
);

CREATE INDEX IF NOT EXISTS idx_user_product_access_user_id ON user_product_access (user_id);
CREATE INDEX IF NOT EXISTS idx_user_product_access_product ON user_product_access (product);
