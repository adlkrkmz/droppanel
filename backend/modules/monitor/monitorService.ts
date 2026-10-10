import { query } from "../../db/client"
import {
  applySearchFilter,
  parseSortBy,
  parseSortDir,
  parseStatusFilter,
  passesStatusFilter,
  sortMonitorItems,
  toSortNumber,
} from "./monitorListingsQuery"
import { fetchStoreSyncStatus } from "../storeSync/storeSyncScheduleService"
import type {
  MonitorItem,
  MonitorListingsResult,
  GetMonitorListingsOptions,
} from "./monitorTypes"

import {
  parseAsinFromSku,
  parseAsinFromSourceUrl,
  resolveListingAsin,
} from "./listingAsinResolve"

export { parseAsinFromSku, parseAsinFromSourceUrl, resolveListingAsin }

async function getStoreByCode(
  workspaceId: string,
  storeCode:   string
): Promise<{ id: number; name: string } | null> {
  const result = await query<{ id: number; name: string }>(
    `SELECT id, name FROM stores
     WHERE workspace_id = $1 AND store_code = $2 AND status = 'active' LIMIT 1`,
    [workspaceId, storeCode]
  )
  return result.rows[0] ?? null
}

async function fetchAmazonCostsByAsins(
  workspaceId: string,
  asins:       string[]
): Promise<Map<string, number | null>> {
  if (asins.length === 0) return new Map()

  const result = await query<{ asin: string; amazon_cost: string | null }>(
    `SELECT ar.asin, apc.price::text AS amazon_cost
     FROM asin_registry ar
     LEFT JOIN amazon_product_cache apc ON apc.asin_registry_id = ar.id
     WHERE ar.workspace_id = $1 AND ar.asin = ANY($2::text[])`,
    [workspaceId, asins]
  )

  const map = new Map<string, number | null>()
  for (const r of result.rows) {
    const raw = r.amazon_cost?.trim()
    if (!raw) {
      map.set(r.asin, null)
      continue
    }
    const n = parseFloat(raw)
    map.set(r.asin, Number.isFinite(n) ? n : null)
  }
  return map
}

type CatalogListRow = {
  id: number
  internal_sku: string
  ebay_item_id:          string | null
  ebay_title:            string | null
  ebay_price:            string | null
  ebay_quantity:         number | null
  ebay_price_synced_at:  string | null
  image_url:             string | null
  source_url:            string | null
  listed_at:             string | null
  current_status:        string | null
  registry_asin:         string | null
  stock_guard_enabled:   boolean
  panel_hidden_at:       string | null
  source_status:         string | null
  source_status_reason:  string | null
  source_price:          string | null
  source_checked_at:     string | null
  bot_zeroed_at:         string | null
  bot_zeroed_reason:     string | null
  bot_zeroed_by:         string | null
  total_sold:            number | null
  sold_30d:              number | null
  clicks_30d:            number | null
  views_30d:             number | null
  impressions_30d:       number | null
  watch_count:           number | null
  metrics_synced_at:     string | null
  metrics_source:        string | null
  metrics_error:         string | null
  auto_price_protected_at: string | null
}

/**
 * store_catalog_state + LEFT JOIN asin_registry + optional amazon_product_cache (cost).
 */
export async function getMonitorListings(
  workspaceId: string,
  storeCode:   string,
  offset:      number,
  limit:       number,
  options:     GetMonitorListingsOptions = {}
): Promise<MonitorListingsResult> {
  const generatedAt = new Date().toISOString()
  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error("Active store not found")

  console.log(`[MonitorListings] storeCode=${storeCode} store_id=${store.id}`)

  const safeLimit  = Math.max(1, Math.min(200, limit))
  const safeOffset = Math.max(0, offset)
  const includeHidden = options.includeHidden === true
  const hiddenClause = includeHidden ? "" : " AND scs.panel_hidden_at IS NULL"

  const statsRes = await query<{ total: string; tracked: string; untracked: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (
         WHERE ebay_item_id IS NOT NULL AND trim(ebay_item_id::text) <> ''
       )::text AS tracked,
       COUNT(*) FILTER (
         WHERE ebay_item_id IS NULL OR trim(ebay_item_id::text) = ''
       )::text AS untracked
     FROM store_catalog_state scs
     WHERE scs.workspace_id = $1 AND scs.store_id = $2${includeHidden ? "" : " AND scs.panel_hidden_at IS NULL"}`,
    [workspaceId, store.id]
  )
  const stats = statsRes.rows[0]
  const total = parseInt(stats?.total ?? "0", 10) || 0
  const tracked = parseInt(stats?.tracked ?? "0", 10) || 0
  const untracked = parseInt(stats?.untracked ?? "0", 10) || 0

  const listRes = await query<CatalogListRow>(
    `SELECT scs.id,
            scs.internal_sku,
            scs.ebay_item_id,
            scs.ebay_title,
            scs.ebay_price::text AS ebay_price,
            scs.ebay_quantity,
            scs.ebay_price_synced_at::text AS ebay_price_synced_at,
            scs.image_url,
            scs.source_url,
            scs.listed_at::text AS listed_at,
            scs.current_status::text AS current_status,
            ar.asin AS registry_asin,
            COALESCE(scs.stock_guard_enabled, true) AS stock_guard_enabled,
            scs.panel_hidden_at::text AS panel_hidden_at,
            scs.source_status,
            scs.source_status_reason,
            scs.source_price::text AS source_price,
            scs.source_checked_at::text AS source_checked_at,
            scs.bot_zeroed_at::text AS bot_zeroed_at,
            scs.bot_zeroed_reason,
            scs.bot_zeroed_by,
            scs.total_sold,
            scs.sold_30d,
            scs.clicks_30d,
            scs.views_30d,
            scs.impressions_30d,
            scs.watch_count,
            scs.metrics_synced_at::text AS metrics_synced_at,
            scs.metrics_source,
            scs.metrics_error,
            scs.auto_price_protected_at::text AS auto_price_protected_at
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1 AND scs.store_id = $2${hiddenClause}
     ORDER BY scs.updated_at DESC`,
    [workspaceId, store.id]
  )

  const asinSet = new Set<string>()
  for (const r of listRes.rows) {
    const a = resolveListingAsin({
      registryAsin: r.registry_asin,
      sourceUrl:    r.source_url,
      internalSku:  r.internal_sku?.trim() ?? "",
    })
    if (a) asinSet.add(a)
  }
  const costMap = await fetchAmazonCostsByAsins(workspaceId, [...asinSet])

  const allItems: MonitorItem[] = listRes.rows.map(row => {
    const sku = row.internal_sku?.trim() ?? ""
    const ep =
      row.ebay_price != null && String(row.ebay_price).trim() !== ""
        ? parseFloat(String(row.ebay_price))
        : NaN
    const ebayPrice = Number.isFinite(ep) ? ep : 0
    const quantity = row.ebay_quantity ?? 0
    const title = row.ebay_title?.trim() ?? ""
    const ebayItemId = row.ebay_item_id?.trim() || null
    const lastSyncAt = row.ebay_price_synced_at?.trim() || null
    const isTracked = ebayItemId != null && ebayItemId.length > 0

    const asin = resolveListingAsin({
      registryAsin: row.registry_asin,
      sourceUrl:    row.source_url,
      internalSku:  sku,
    })
    const cost = asin ? (costMap.get(asin) ?? null) : null
    const margin =
      cost !== null && ebayPrice > 0 && Number.isFinite(cost)
        ? Math.round(((ebayPrice - cost) / ebayPrice) * 100 * 100) / 100
        : null

    const sourcePriceRaw = row.source_price?.trim()
    const sourcePriceParsed =
      sourcePriceRaw != null && sourcePriceRaw !== ""
        ? parseFloat(sourcePriceRaw)
        : NaN
    const sourcePrice = Number.isFinite(sourcePriceParsed) ? sourcePriceParsed : null

    return {
      catalogStateId: Number(row.id) || null,
      sku,
      title,
      ebayItemId,
      ebayPrice,
      quantity,
      cost,
      isTracked,
      lastSyncAt,
      margin,
      asin,
      image: row.image_url?.trim() || null,
      sourceUrl: row.source_url?.trim() || null,
      listedAt: row.listed_at?.trim() || null,
      currentStatus: row.current_status?.trim() || null,
      stockGuardEnabled: row.stock_guard_enabled !== false,
      panelHiddenAt: row.panel_hidden_at?.trim() || null,
      sourceStatus: row.source_status?.trim() || null,
      sourceStatusReason: row.source_status_reason?.trim() || null,
      sourcePrice,
      sourceCheckedAt: row.source_checked_at?.trim() || null,
      botZeroedAt: row.bot_zeroed_at?.trim() || null,
      botZeroedReason: row.bot_zeroed_reason?.trim() || null,
      botZeroedBy: row.bot_zeroed_by?.trim() || null,
      totalSold: toSortNumber(row.total_sold),
      sold30d: toSortNumber(row.sold_30d),
      clicks30d: toSortNumber(row.clicks_30d),
      clicks30dCheckedAt: null,
      views30d: toSortNumber(row.views_30d),
      impressions30d: toSortNumber(row.impressions_30d),
      watchCount: toSortNumber(row.watch_count),
      metricsSyncedAt: row.metrics_synced_at?.trim() || null,
      metricsSource: row.metrics_source?.trim() || null,
      metricsError: row.metrics_error?.trim() || null,
      autoPriceProtectedAt: row.auto_price_protected_at?.trim() || null,
    }
  })

  const statusKey = parseStatusFilter(options.status)
  const searchQ = options.search?.trim() ?? ""
  const sortBy = parseSortBy(options.sortBy)
  const sortDir = parseSortDir(options.sortDir)

  let filtered = allItems
  if (statusKey !== "all") {
    filtered = filtered.filter(item => passesStatusFilter(item, statusKey))
  }
  filtered = applySearchFilter(filtered, searchQ)
  filtered = sortMonitorItems(filtered, sortBy, sortDir)

  const filteredTotal = filtered.length
  const totalPages = Math.max(1, Math.ceil(filteredTotal / safeLimit))
  const currentPage = Math.min(
    totalPages,
    Math.floor(safeOffset / safeLimit) + 1
  )
  const items = filtered.slice(safeOffset, safeOffset + safeLimit)

  const storeSync = await fetchStoreSyncStatus(store.id)

  return {
    store:              store.name?.trim() || "Store",
    total:              filteredTotal,
    ebayInventoryTotal: total,
    tracked,
    untracked,
    simulationMode:     false,
    items,
    generatedAt,
    currentPage,
    totalPages,
    pageSize:           safeLimit,
    appliedSortBy:      sortBy ?? null,
    appliedSortDir:     sortBy ? sortDir : null,
    storeSync:          storeSync ?? undefined,
  }
}
