export const AMAZON_VERIFICATION_CLAIM_SQL = `
WITH expired AS (
  UPDATE amazon_price_verification_tasks
  SET status = CASE
        WHEN status IN ('CLAIMED', 'RUNNING') THEN 'PENDING'
        ELSE status
      END,
      worker_id = NULL,
      claimed_by_source = NULL,
      lease_expires_at = NULL,
      claimed_at = NULL,
      updated_at = NOW()
  WHERE workspace_id = $1::uuid
    AND preferred_user_id = $2::uuid
    AND status IN ('CLAIMED', 'RUNNING')
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at < NOW()
  RETURNING id
),
candidate AS (
  SELECT t.id
  FROM amazon_price_verification_tasks t
  WHERE t.workspace_id = $1::uuid
    AND t.preferred_user_id = $2::uuid
    AND t.status IN ('PENDING', 'RETRYABLE', 'WAITING_FOR_WORKER')
    AND t.available_at <= NOW()
    AND (t.lease_expires_at IS NULL OR t.lease_expires_at < NOW())
    AND ($5::boolean = true OR t.reason = 'ADMIN_TEST')
  ORDER BY t.priority ASC, t.available_at ASC NULLS FIRST, t.id ASC
  LIMIT 1
  FOR UPDATE OF t SKIP LOCKED
)
UPDATE amazon_price_verification_tasks t
SET status = 'CLAIMED',
    worker_id = $3::text,
    claimed_by_source = 'EXTENSION',
    claimed_at = NOW(),
    started_at = COALESCE(t.started_at, NOW()),
    lease_expires_at = NOW() + make_interval(secs => $4::int),
    updated_at = NOW()
FROM candidate
WHERE t.id = candidate.id
RETURNING t.id, t.global_asin_id, t.workspace_id::text AS workspace_id,
          t.preferred_user_id::text AS preferred_user_id, t.catalog_state_id,
          t.asin, t.amazon_url, t.reason, t.status, t.attempt_count,
          t.lease_expires_at
`
