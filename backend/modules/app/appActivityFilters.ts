// ----------------------------------------------------------------
// appActivityFilters.ts — /app/activity query filters (Phase 5S)
// ----------------------------------------------------------------

import { AppHttpError, type AppActivityActionFilter } from "./appTypes"

const VALID_ACTION_FILTERS = new Set<AppActivityActionFilter>([
  "all",
  "bulk",
  "listings",
  "stock-alerts",
  "stock-guard",
  "settings",
  "ebay",
  "failed",
])

export function parseAppActivityActionFilter(raw: unknown): AppActivityActionFilter {
  const value = String(raw ?? "all").trim().toLowerCase()
  if (!VALID_ACTION_FILTERS.has(value as AppActivityActionFilter)) {
    throw new AppHttpError(400, `Invalid action filter: ${String(raw ?? "")}`)
  }
  return value as AppActivityActionFilter
}

export function parseAppActivitySearch(raw: unknown): string | null {
  const q = String(raw ?? "").trim()
  if (!q) return null
  if (q.length > 100) {
    throw new AppHttpError(400, "Search query too long (max 100 characters)")
  }
  return q
}

export function buildActivityActionFilterClause(
  filter: AppActivityActionFilter
): string {
  switch (filter) {
    case "bulk":
      return `al.action LIKE 'app.bulk.%'`
    case "listings":
      return `(al.action LIKE 'app.listings.%' OR al.action LIKE 'app.bulk.listings.%')`
    case "stock-alerts":
      return `(al.action LIKE 'app.stock_alerts.%' OR al.action LIKE 'app.bulk.stock_alerts.%')`
    case "stock-guard":
      return `(al.action LIKE 'app.stock_guard.%' OR al.action LIKE 'app.listings.stock_guard.%' OR al.action LIKE 'app.bulk.listings.stock_guard.%')`
    case "settings":
      return `al.action LIKE 'app.settings.%'`
    case "ebay":
      return `al.action LIKE 'app.ebay.%'`
    case "failed":
      return `al.action LIKE 'app.%' AND al.action LIKE '%.failed'`
    case "all":
    default:
      return `al.action LIKE 'app.%'`
  }
}

export function buildActivitySearchClause(
  q: string,
  paramIndex: number
): { clause: string; params: string[] } {
  const pattern = `%${q}%`
  const p = `$${paramIndex}`
  return {
    clause: `(
      al.action ILIKE ${p}
      OR al.target_id ILIKE ${p}
      OR al.metadata->>'storeCode' ILIKE ${p}
      OR al.metadata->>'catalogStateId' ILIKE ${p}
      OR al.metadata->>'alertId' ILIKE ${p}
      OR al.metadata->>'ebayItemId' ILIKE ${p}
      OR al.metadata->>'asin' ILIKE ${p}
      OR al.metadata->>'batchId' ILIKE ${p}
    )`,
    params: [pattern],
  }
}
