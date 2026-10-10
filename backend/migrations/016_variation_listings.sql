-- Varyasyon grubu
CREATE TABLE variation_products (
  id                BIGSERIAL PRIMARY KEY,
  workspace_id      UUID NOT NULL,
  asin              TEXT NOT NULL,
  source            TEXT NOT NULL,
  title             TEXT,
  brand             TEXT,
  description       TEXT,
  images            JSONB,
  video_url         TEXT,
  video_r2_url      TEXT,
  category          TEXT,
  store_code        TEXT,
  status            TEXT DEFAULT 'pending',
  ebay_item_id      TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Her varyant
CREATE TABLE variation_items (
  id                    BIGSERIAL PRIMARY KEY,
  variation_product_id  BIGINT REFERENCES variation_products(id) ON DELETE CASCADE,
  sku                   TEXT NOT NULL UNIQUE,
  aspect_name           TEXT NOT NULL,
  aspect_value          TEXT NOT NULL,
  price                 NUMERIC,
  quantity              INT DEFAULT 10,
  images                JSONB,
  ebay_offer_id         TEXT,
  status                TEXT DEFAULT 'pending',
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_variation_products_workspace ON variation_products(workspace_id);
CREATE INDEX idx_variation_products_asin ON variation_products(asin);
CREATE INDEX idx_variation_items_product ON variation_items(variation_product_id);
