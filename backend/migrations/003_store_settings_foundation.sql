-- Foundation schema for store_settings.
-- Historical deployments already had this table before migration 004.
-- Required so a clean database can replay the full migration chain.

CREATE TABLE IF NOT EXISTS store_settings (
    id BIGSERIAL PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    store_id BIGINT NOT NULL REFERENCES stores(id),

    profit_margin_percent NUMERIC(5,2) NOT NULL DEFAULT 25.00,
    tax_estimate_percent NUMERIC(5,2) NOT NULL DEFAULT 8.00,
    ebay_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 13.00,
    default_quantity INTEGER NOT NULL DEFAULT 1,

    template_id TEXT,
    merchant_location_key TEXT,
    payment_policy_id TEXT,
    return_policy_id TEXT,
    fulfillment_policy_id TEXT,

    interval_minutes INTEGER NOT NULL DEFAULT 30,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (workspace_id, store_id)
);
