// ----------------------------------------------------------------
// appStockAlertFilters.ts — user /app/stock-alerts query filters
// ----------------------------------------------------------------

import { STOCK_ALERTS_OPERATIONAL_FEED_SQL } from "../stockAlerts/stockAlertListQuery"
import { AppHttpError, type AppStockAlertRisk, type AppStockAlertStatus } from "./appTypes"

const VALID_STATUSES = new Set<AppStockAlertStatus>([
  "pending",
  "processing",
  "actioned",
  "ignored",
  "failed",
  "all",
])

const VALID_RISKS = new Set<AppStockAlertRisk>([
  "all",
  "needs-review",
  "price-increase",
  "source-unavailable",
  "no-trusted-price",
  "check-failed",
])

/** App /app/stock-alerts list+count window: new rows or Stock Guard actions in the last 24h. */
export const STOCK_ALERTS_APP_CREATED_LAST_24H_SQL = `(
  sri.created_at >= NOW() - INTERVAL '24 hours'
  OR (
    sri.review_status = 'actioned'
    AND sri.actioned_at IS NOT NULL
    AND sri.actioned_at >= NOW() - INTERVAL '24 hours'
  )
)`

const RISKY_SOURCE_STATUSES = [
  "PRICE_INCREASE",
  "NO_PRICE",
  "UNAVAILABLE",
  "REMOVED",
  "PRICE_UNCERTAIN",
  "CHECK_FAILED",
] as const

export function parseAppStockAlertStatus(raw: unknown): AppStockAlertStatus {
  const value = String(raw ?? "all").trim().toLowerCase()
  if (!VALID_STATUSES.has(value as AppStockAlertStatus)) {
    throw new AppHttpError(400, `Invalid status: ${String(raw ?? "")}`)
  }
  return value as AppStockAlertStatus
}

export function parseAppStockAlertRisk(raw: unknown): AppStockAlertRisk {
  const value = String(raw ?? "all").trim().toLowerCase()
  if (!VALID_RISKS.has(value as AppStockAlertRisk)) {
    throw new AppHttpError(400, `Invalid risk: ${String(raw ?? "")}`)
  }
  return value as AppStockAlertRisk
}

export function parseAppStockAlertSearch(raw: unknown): string | null {
  const q = String(raw ?? "").trim()
  if (!q) return null
  if (q.length > 100) {
    throw new AppHttpError(400, "Search query too long (max 100 characters)")
  }
  return q
}

export function buildStatusFilterClause(
  status: AppStockAlertStatus,
  paramIndex: number
): { clause: string; params: unknown[] } {
  if (status === "all") {
    return { clause: "", params: [] }
  }
  if (status === "pending") {
    return {
      clause: ` AND (${STOCK_ALERTS_OPERATIONAL_FEED_SQL})`,
      params: [],
    }
  }
  return {
    clause: ` AND sri.review_status = $${paramIndex}`,
    params: [status],
  }
}

export function buildRiskFilterClause(risk: AppStockAlertRisk): { clause: string; params: unknown[] } {
  switch (risk) {
    case "needs-review":
      return {
        clause: ` AND (
          sri.review_status = 'pending'
          OR sri.source_status IN (${RISKY_SOURCE_STATUSES.map(s => `'${s}'`).join(", ")})
        )`,
        params: [],
      }
    case "price-increase":
      return { clause: " AND sri.source_status = 'PRICE_INCREASE'", params: [] }
    case "source-unavailable":
      return { clause: " AND sri.source_status IN ('UNAVAILABLE', 'REMOVED')", params: [] }
    case "no-trusted-price":
      return { clause: " AND sri.source_status IN ('NO_PRICE', 'PRICE_UNCERTAIN')", params: [] }
    case "check-failed":
      return { clause: " AND sri.source_status = 'CHECK_FAILED'", params: [] }
    default:
      return { clause: "", params: [] }
  }
}

export function buildSearchFilterClause(
  search: string,
  paramIndex: number
): { clause: string; params: unknown[] } {
  return {
    clause: ` AND (
      sri.asin ILIKE $${paramIndex}
      OR COALESCE(sri.ebay_item_id, '') ILIKE $${paramIndex}
      OR COALESCE(sri.source_status_reason, '') ILIKE $${paramIndex}
      OR COALESCE(sri.action_error, '') ILIKE $${paramIndex}
      OR COALESCE(NULLIF(trim(sri.ebay_title), ''), NULLIF(trim(scs.ebay_title), ''), '') ILIKE $${paramIndex}
    )`,
    params: [`%${search}%`],
  }
}
