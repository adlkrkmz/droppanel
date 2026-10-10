-- Workspace-scoped Gmail mailboxes.
-- Preserves legacy store bindings and all existing tokens/messages while making
-- the mailbox connection independent from a store for new ingestion.

ALTER TABLE mailbox_accounts
  ALTER COLUMN store_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mailbox_accounts_workspace_provider_account
  ON mailbox_accounts (workspace_id, provider, provider_account_id);

CREATE INDEX IF NOT EXISTS idx_mailbox_accounts_workspace_status
  ON mailbox_accounts (workspace_id, status, last_ingested_at);

ALTER TABLE mailbox_messages
  ALTER COLUMN store_id DROP NOT NULL;

ALTER TABLE mailbox_link_reviews
  ALTER COLUMN store_id DROP NOT NULL;

COMMENT ON COLUMN mailbox_accounts.store_id IS
  'Deprecated legacy binding. New mailbox connections are workspace-scoped and leave this NULL.';

COMMENT ON COLUMN mailbox_messages.store_id IS
  'Derived from the reliably matched ebay_orders.store_id; NULL until/unless matched.';
