// ----------------------------------------------------------------
// appListingFilters.ts — shared listing filter SQL (user /app/listings)
// ----------------------------------------------------------------

import { AppHttpError, type AppListingsFilter, type AppListingsSort } from "./appTypes"

const SORT_COLUMNS: Record<AppListingsSort, string> = {
  title: "scs.ebay_title", asin: "ar.asin", ebayPrice: "scs.ebay_price", sourcePrice: "scs.source_price",
  quantity: "scs.ebay_quantity", status: "scs.current_status", stockGuard: "scs.stock_guard_enabled",
  profitProtection: "scs.auto_price_protected_at", updated: "scs.updated_at", listedAt: "scs.listed_at",
  totalSold: "scs.total_sold", clicks30d: "scs.clicks_30d",
}

export function parseAppListingsSort(raw: unknown): AppListingsSort | null {
  const value = String(raw ?? "").trim()
  if (!value) return null
  if (!(value in SORT_COLUMNS)) throw new AppHttpError(400, "Invalid sort")
  return value as AppListingsSort
}

export function listingsOrderBy(sort: AppListingsSort | null, direction: string): string {
  const dir = String(direction).trim().toLowerCase() === "asc" ? "ASC" : "DESC"
  // Sold: NULL displays as 0 — sort with the same presentation semantics (do not rewrite DB).
  if (sort === "totalSold") {
    return `ORDER BY COALESCE(scs.total_sold, 0) ${dir}, scs.id DESC`
  }
  const column = sort ? SORT_COLUMNS[sort] : "scs.updated_at"
  return `ORDER BY ${column} ${dir} NULLS LAST, scs.id DESC`
}

export function listingsSearchWhereClause(q: string): { sql: string; value: string } {
  const value = q.trim()
  if (!value) return { sql: "", value: "" }
  return {
    sql: `AND (
      COALESCE(scs.ebay_title, '')::text ILIKE $3 OR
      COALESCE(scs.ebay_item_id, '')::text ILIKE $3 OR
      COALESCE(ar.asin, '')::text ILIKE $3 OR
      COALESCE(scs.internal_sku, '')::text ILIKE $3 OR
      COALESCE(scs.source_url, '')::text ILIKE $3
    )`,
    value: `%${value}%`,
  }
}

/** Matches resolveListingAsin() in monitorService (registry → source_url → SKU). */
export const LISTING_HAS_ASIN_SQL = `(
  (ar.asin IS NOT NULL AND upper(trim(ar.asin)) ~ '^[A-Z0-9]{10}$')
  OR (
    scs.source_url IS NOT NULL AND (
      scs.source_url ~* 'amazon\\.com/dp/[A-Z0-9]{10}'
      OR scs.source_url ~* 'amazon\\.com/gp/product/[A-Z0-9]{10}'
    )
  )
  OR upper(trim(scs.internal_sku)) ~ '^[A-Z0-9]{10}$'
  OR scs.internal_sku ~* '^DP-([A-Z0-9]{10})-'
  OR scs.internal_sku ~* '^DP([A-Z0-9]{10})'
)`

const VALID_FILTERS = new Set<AppListingsFilter>([
  "all",
  "needs-asin",
  "asin-linked",
  "source-tracked",
  "source-missing",
  "guard-on",
  "guard-off",
  "qty0",
  "bot_zeroed",
  "unavailable",
  "no_price",
  "check_failed",
])

export function parseAppListingsFilter(raw: unknown): AppListingsFilter {
  const value = String(raw ?? "all").trim().toLowerCase()
  if (!VALID_FILTERS.has(value as AppListingsFilter)) {
    throw new AppHttpError(400, `Invalid filter: ${String(raw ?? "")}`)
  }
  return value as AppListingsFilter
}

/** SQL fragment appended after base WHERE (requires LEFT JOIN asin_registry ar for ASIN filters). */
export function listingsFilterWhereClause(filter: AppListingsFilter): string {
  switch (filter) {
    case "needs-asin":
      return `AND NOT (${LISTING_HAS_ASIN_SQL})`
    case "asin-linked":
      return `AND (${LISTING_HAS_ASIN_SQL})`
    case "source-tracked":
      return `AND (
        scs.source_price IS NOT NULL
        OR (scs.source_price_source IS NOT NULL AND trim(scs.source_price_source) <> '')
      )`
    case "source-missing":
      return `AND scs.source_price IS NULL
        AND (scs.source_price_source IS NULL OR trim(scs.source_price_source) = '')`
    case "guard-on":
      return `AND COALESCE(scs.stock_guard_enabled, true) = true`
    case "guard-off":
      return `AND COALESCE(scs.stock_guard_enabled, true) = false`
    case "qty0":
      return `AND COALESCE(scs.ebay_quantity, 0) = 0`
    case "bot_zeroed":
      return `AND (
        scs.bot_zeroed_at IS NOT NULL
        OR upper(trim(COALESCE(scs.source_status, ''))) = 'BOT_ZEROED'
      )`
    case "unavailable":
      return `AND upper(trim(COALESCE(scs.source_status, ''))) IN ('UNAVAILABLE', 'REMOVED', 'AMAZON_UNAVAILABLE')`
    case "no_price":
      return `AND upper(trim(COALESCE(scs.source_status, ''))) IN ('NO_PRICE', 'PRICE_UNCERTAIN')`
    case "check_failed":
      return `AND upper(trim(COALESCE(scs.source_status, ''))) = 'CHECK_FAILED'`
    default:
      return ""
  }
}

export const LISTINGS_BASE_FROM_JOIN = `
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     LEFT JOIN ebay_listing_promotions elp
       ON elp.store_id = scs.store_id
      AND elp.ebay_listing_id = NULLIF(trim(scs.ebay_item_id), '')
      AND elp.workspace_id = scs.workspace_id`

export const LISTINGS_BASE_WHERE = `
     WHERE scs.workspace_id = $1::uuid
       AND s.workspace_id = $1::uuid
       AND s.store_code = $2
       AND scs.panel_hidden_at IS NULL`
