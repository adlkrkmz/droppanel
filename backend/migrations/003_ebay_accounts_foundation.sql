-- Foundation schema for ebay_accounts.
-- Historical deployments already had this table outside the migration chain.
-- Required so a clean database can replay schema and restore existing eBay account data.

CREATE TABLE IF NOT EXISTS ebay_accounts (
    id BIGSERIAL PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    store_id BIGINT NOT NULL REFERENCES stores(id),

    ebay_user_id TEXT,
    access_token TEXT,
    refresh_token TEXT,
    expires_at TIMESTAMPTZ,
    scope TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (workspace_id, store_id)
);
