// ----------------------------------------------------------------
// appStockAlertsService.ts — user-safe stock alert reads
// ----------------------------------------------------------------
import { queryWithoutJit } from "../../db/client"
import type {
  AppStockAlertItem,
  AppStockAlertRisk,
  AppStockAlertStatus,
  AppStockAlertsResponse,
} from "./appTypes"
import type { OwnedStore } from "./appOwnership"
import {
  STOCK_ALERTS_APP_CREATED_LAST_24H_SQL,
  buildRiskFilterClause,
  buildSearchFilterClause,
  buildStatusFilterClause,
} from "./appStockAlertFilters"
import { STOCK_ALERTS_VISIBLE_SQL } from "../stockAlerts/stockAlertListQuery"
function parsePrice(raw: string | null | undefined): number | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  const n = parseFloat(trimmed)
  return Number.isFinite(n) ? n : null
}

function toIsoUtc(raw: string | Date | null | undefined): string {
  if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.toISOString()
  const s = String(raw ?? "").trim()
  if (!s) return ""
  const norm = s.includes("T")
    ? s
    : s.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00").replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
  const d = new Date(norm)
  return Number.isFinite(d.getTime()) ? d.toISOString() : ""
}
const HIDDEN_LISTING_CLAUSE = `
  AND (
    scs.id IS NULL
    OR scs.panel_hidden_at IS NULL
  )
  AND (${STOCK_ALERTS_VISIBLE_SQL})
  AND ${STOCK_ALERTS_APP_CREATED_LAST_24H_SQL}`
const FROM_CLAUSE = `
  FROM stock_review_items sri
  INNER JOIN stores s
    ON s.id = sri.store_id
   AND s.workspace_id = sri.workspace_id
  LEFT JOIN store_catalog_state scs
    ON scs.id = sri.catalog_state_id
   AND scs.workspace_id = sri.workspace_id
   AND scs.store_id = s.id`
function appendFilter(
  baseParams: unknown[],
  filter: { clause: string; params: unknown[] }
): { params: unknown[]; clause: string } {
  if (!filter.clause) {
    return { params: baseParams, clause: "" }
  }
  const nextIndex = baseParams.length + 1
  let clause = filter.clause
  if (filter.params.length > 0) {
    clause = clause.replace(/\$(\d+)/g, (_match, num: string) => {
      return `$${parseInt(num, 10) + baseParams.length}`
    })
  }
  return {
    params: [...baseParams, ...filter.params],
    clause,
  }
}
export async function getAppStockAlerts(input: {
  workspaceId: string
  store:       OwnedStore
  status:      AppStockAlertStatus
  risk:        AppStockAlertRisk
  search:      string | null
  page:        number
  limit:       number
}): Promise<AppStockAlertsResponse> {
  const safeLimit = Math.max(1, Math.min(100, input.limit))
  const baseParams: unknown[] = [input.workspaceId, input.store.storeCode]
  const statusPart = buildStatusFilterClause(input.status, baseParams.length + 1)
  let whereParams = [...baseParams, ...statusPart.params]
  let filterClause = statusPart.clause
  const riskPart = buildRiskFilterClause(input.risk)
  if (riskPart.clause) {
    filterClause += riskPart.clause
    whereParams = [...whereParams, ...riskPart.params]
  }
  if (input.search) {
    const searchPart = buildSearchFilterClause(input.search, whereParams.length + 1)
    filterClause += searchPart.clause
    whereParams = [...whereParams, ...searchPart.params]
  }
  const countRes = await queryWithoutJit<{ total: string }>(
    `SELECT COUNT(*)::text AS total
     ${FROM_CLAUSE}
     WHERE sri.workspace_id = $1::uuid
       AND s.workspace_id = $1::uuid
       AND s.store_code = $2
       ${HIDDEN_LISTING_CLAUSE}
       ${filterClause}`,
    whereParams
  )
  const total = parseInt(countRes.rows[0]?.total ?? "0", 10) || 0
  const totalPages = Math.max(1, Math.ceil(total / safeLimit))
  let safePage = Math.max(1, input.page)
  if (total === 0) safePage = 1
  else if (safePage > totalPages) safePage = totalPages
  const safeOffset = (safePage - 1) * safeLimit
  const listParams = [...whereParams, safeLimit, safeOffset]
  const limitIdx = whereParams.length + 1
  const offsetIdx = whereParams.length + 2
  const listRes = await queryWithoutJit<{
    id: number
    catalog_state_id: number
    ebay_item_id: string | null
    asin: string
    source_status: string
    source_status_reason: string | null
    verification_source: string | null
    review_status: string
    ebay_price: string | null
    source_price: string | null
    old_source_price: string | null
    new_source_price: string | null
    price_change_percent: string | null
    action_error: string | null
    created_at: string
    updated_at: string
    ebay_title: string | null
    ebay_quantity: number | null
    catalog_ebay_price: string | null
    image_url: string | null
  }>(
    `SELECT
       sri.id,
       sri.catalog_state_id,
       sri.ebay_item_id,
       sri.asin,
       sri.source_status,
       sri.source_status_reason,
       COALESCE(
         NULLIF(BTRIM(sri.verification_source), ''),
         (
           SELECT NULLIF(BTRIM(e.after_data->>'source'), '')
           FROM workspace_activity_events e
           WHERE e.workspace_id = sri.workspace_id
             AND e.catalog_state_id = sri.catalog_state_id
             AND e.event_type IN ('PRICE_PROTECTION_APPLIED', 'ACTION_FAILED', 'STOCK_ZEROED', 'STOCK_ZERO_FAILED')
           ORDER BY e.created_at DESC, e.id DESC
           LIMIT 1
         ),
         (
           SELECT CASE UPPER(BTRIM(t.claimed_by_source))
             WHEN 'DESKTOP_AGENT' THEN 'DESKTOP_AGENT'
             WHEN 'SERVER_BROWSER_AUTH' THEN 'SERVER_BROWSER_AUTH'
             WHEN 'SERVER_BROWSER_PUBLIC' THEN 'SERVER_BROWSER_PUBLIC'
             WHEN 'SERVER' THEN 'SERVER_BROWSER'
             ELSE NULL
           END
           FROM amazon_price_verification_tasks t
           WHERE t.workspace_id = sri.workspace_id
             AND t.catalog_state_id = sri.catalog_state_id
             AND t.status = 'COMPLETED'
           ORDER BY t.completed_at DESC NULLS LAST, t.id DESC
           LIMIT 1
         )
       ) AS verification_source,
       sri.review_status,
       sri.ebay_price::text AS ebay_price,
       sri.source_price::text AS source_price,
       sri.old_source_price::text AS old_source_price,
       sri.new_source_price::text AS new_source_price,
       sri.price_change_percent::text AS price_change_percent,
       sri.action_error,
       sri.created_at::text AS created_at,
       sri.updated_at::text AS updated_at,
       COALESCE(NULLIF(trim(sri.ebay_title), ''), NULLIF(trim(scs.ebay_title), '')) AS ebay_title,
       COALESCE(sri.ebay_quantity, scs.ebay_quantity) AS ebay_quantity,
       scs.ebay_price::text AS catalog_ebay_price,
       COALESCE(NULLIF(trim(sri.image_url), ''), NULLIF(trim(scs.image_url), '')) AS image_url
     ${FROM_CLAUSE}
     WHERE sri.workspace_id = $1::uuid
       AND s.workspace_id = $1::uuid
       AND s.store_code = $2
       ${HIDDEN_LISTING_CLAUSE}
       ${filterClause}
     ORDER BY GREATEST(sri.created_at, COALESCE(sri.actioned_at, sri.created_at)) DESC, sri.id DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    listParams
  )
  const items: AppStockAlertItem[] = listRes.rows.map(r => ({
    alertId:            r.id,
    catalogStateId:     r.catalog_state_id,
    ebayItemId:         r.ebay_item_id?.trim() || null,
    asin:               r.asin,
    sourceStatus:       r.source_status,
    sourceStatusReason: r.source_status_reason?.trim() || null,
    verificationSource: r.verification_source?.trim() || null,
    reviewStatus:       r.review_status,
    ebayPrice:          parsePrice(r.ebay_price),
    sourcePrice:        parsePrice(r.source_price),
    oldSourcePrice:     parsePrice(r.old_source_price),
    newSourcePrice:     parsePrice(r.new_source_price),
    priceChangePercent: parsePrice(r.price_change_percent),
    actionError:        r.action_error?.trim() || null,
    createdAt:          toIsoUtc(r.created_at),
    updatedAt:          toIsoUtc(r.updated_at),
    listingTitle:       r.ebay_title?.trim() || null,
    currentDbPrice:     parsePrice(r.catalog_ebay_price),
    ebayQuantity:       r.ebay_quantity ?? null,
    imageUrl:           r.image_url?.trim() || null,
    storeId:            input.store.id,
  }))
  return {
    ok:        true,
    storeCode: input.store.storeCode,
    storeId:   input.store.id,
    status:    input.status,
    risk:      input.risk,
    q:         input.search,
    page:      safePage,
    limit:     safeLimit,
    total,
    items,
  }
}
