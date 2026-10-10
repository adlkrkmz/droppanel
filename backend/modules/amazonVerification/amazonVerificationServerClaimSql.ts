export const AMAZON_VERIFICATION_SERVER_CLAIM_SQL = `
WITH expired AS (
  -- Only reclaim lease-expired CLAIMED rows here.
  -- Expired RUNNING is recovered by the Amazon Worker expired-RUNNING watchdog
  -- via canonical failVerificationTask (attempt_count + retry delay).
  UPDATE amazon_price_verification_tasks
  SET status = 'PENDING',
      worker_id = NULL,
      claimed_by_source = NULL,
      lease_expires_at = NULL,
      claimed_at = NULL,
      updated_at = NOW()
  WHERE worker_id = $1::text
    AND status = 'CLAIMED'
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at < NOW()
  RETURNING id
),
candidate AS (
  SELECT t.id
  FROM amazon_price_verification_tasks t
  WHERE t.status IN ('PENDING', 'RETRYABLE', 'WAITING_FOR_WORKER')
    AND t.available_at <= NOW()
    AND (t.lease_expires_at IS NULL OR t.lease_expires_at < NOW())
    -- Auth price-fallback rows are owned exclusively by the login worker.
    AND t.claimed_by_source IS DISTINCT FROM 'SERVER_BROWSER_AUTH'
    AND ($3::boolean = true OR t.reason = 'ADMIN_TEST')
  ORDER BY t.priority ASC, t.available_at ASC NULLS FIRST, t.id ASC
  LIMIT 1
  FOR UPDATE OF t SKIP LOCKED
)
UPDATE amazon_price_verification_tasks t
SET status = 'CLAIMED',
    worker_id = $1::text,
    claimed_by_source = 'SERVER_BROWSER',
    claimed_at = NOW(),
    started_at = COALESCE(t.started_at, NOW()),
    lease_expires_at = NOW() + make_interval(secs => $2::int),
    updated_at = NOW()
FROM candidate
WHERE t.id = candidate.id
RETURNING t.id, t.global_asin_id, t.workspace_id::text AS workspace_id,
          t.preferred_user_id::text AS preferred_user_id, t.catalog_state_id,
          t.asin, t.amazon_url, t.reason, t.status, t.attempt_count,
          t.lease_expires_at
`
