import type { StockReviewStatus } from "./stockAlertsTypes"

export const ADMIN_STOCK_REVIEW_STATUSES: StockReviewStatus[] = [
  "pending",
  "processing",
  "actioned",
  "ignored",
  "failed",
  "approved",
]

export function parseAdminStockReviewStatus(raw: unknown): StockReviewStatus {
  const status = String(raw ?? "pending").trim().toLowerCase()
  if (ADMIN_STOCK_REVIEW_STATUSES.includes(status as StockReviewStatus)) {
    return status as StockReviewStatus
  }
  return "pending"
}

/** Default operational list: open pending risks + actioned in last 24h. */
export const STOCK_ALERTS_OPERATIONAL_FEED_SQL = `
  (
    sri.review_status = 'pending'
    OR (
      sri.review_status = 'actioned'
      AND sri.actioned_at IS NOT NULL
      AND sri.actioned_at >= NOW() - INTERVAL '24 hours'
    )
  )
`

export const STOCK_ALERTS_PENDING_OPEN_QTY_SQL = `
  sri.review_status = 'pending'
  AND EXISTS (
    SELECT 1 FROM store_catalog_state scs_open
    WHERE scs_open.id = sri.catalog_state_id
      AND scs_open.workspace_id = sri.workspace_id
      AND scs_open.store_id = sri.store_id
      AND COALESCE(scs_open.ebay_quantity, 0) > 0
  )
`

export const STOCK_ALERTS_ROUTINE_DESKTOP_WAITING_SQL = `
  NOT (
    sri.review_status IN ('pending', 'processing')
    AND sri.source_status IN ('PRICE_UNCERTAIN', 'CHECK_FAILED', 'NO_PRICE')
    AND EXISTS (
      SELECT 1
      FROM amazon_price_verification_tasks waiting_task
      WHERE waiting_task.workspace_id = sri.workspace_id
        AND waiting_task.catalog_state_id = sri.catalog_state_id
        AND waiting_task.status IN (
          'PENDING', 'CLAIMED', 'RUNNING', 'WAITING_FOR_WORKER', 'RETRYABLE'
        )
        AND waiting_task.id = (
          SELECT latest_task.id
          FROM amazon_price_verification_tasks latest_task
          WHERE latest_task.workspace_id = sri.workspace_id
            AND latest_task.catalog_state_id = sri.catalog_state_id
          ORDER BY latest_task.updated_at DESC, latest_task.id DESC
          LIMIT 1
        )
    )
  )
`

/** Shared visibility predicate for every Stock Alerts list/count query. */
export const STOCK_ALERTS_OPERATIONAL_SQL = `
  (
    COALESCE(sri.operation_type, '') IN ('PRICE_PROTECTION', 'STOCK_PROTECTION')
    OR (
      sri.operation_type IS NULL
      AND (
        sri.source_status = 'PRICE_INCREASE'
        OR sri.mutation_attempted = true
        OR EXISTS (
          SELECT 1
          FROM workspace_activity_events operational_event
          WHERE operational_event.workspace_id = sri.workspace_id
            AND operational_event.catalog_state_id = sri.catalog_state_id
            AND operational_event.event_type IN (
              'PRICE_PROTECTION_APPLIED', 'ACTION_FAILED', 'STOCK_ZEROED', 'STOCK_ZERO_FAILED'
            )
        )
        OR (
          sri.review_status = 'actioned'
          AND sri.source_status IN ('UNAVAILABLE', 'REMOVED', 'NO_PRICE')
          AND COALESCE(sri.ebay_quantity, 0) = 0
        )
      )
    )
  )
`

/** Shared visibility predicate for every Stock Alerts list/count query. */
export const STOCK_ALERTS_VISIBLE_SQL = `(
  sri.feed_hidden_at IS NULL
  AND ${STOCK_ALERTS_OPERATIONAL_SQL}
  AND NOT (
    COALESCE(sri.operation_type, '') = 'VERIFICATION'
    OR (
      sri.operation_type IS NULL
      AND sri.mutation_attempted = false
      AND sri.source_status IN ('PRICE_UNCERTAIN', 'CHECK_FAILED', 'NO_PRICE')
    )
  )
  AND ${STOCK_ALERTS_ROUTINE_DESKTOP_WAITING_SQL}
)`

export function buildAdminListStatusClause(status: StockReviewStatus): string {
  const sourceClause = ` AND ${STOCK_ALERTS_VISIBLE_SQL}`
  if (status === "pending") {
    return `${sourceClause} AND (${STOCK_ALERTS_OPERATIONAL_FEED_SQL}) AND (${STOCK_ALERTS_PENDING_OPEN_QTY_SQL})`
  }
  return `${sourceClause} AND sri.review_status = $3`
}
