-- Stock Guard V2 lifecycle: activity idempotency by logical action identity.
-- Additive. Does not drop tables, alter eBay columns, or flip production flags.

ALTER TABLE workspace_activity_events
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_activity_idempotency
  ON workspace_activity_events (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
