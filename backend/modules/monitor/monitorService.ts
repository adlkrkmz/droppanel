import { query } from "../../db/client"
import type {
  MonitorItem,
  MonitorListingsResult,
} from "./monitorTypes"

function parseAsinFromSku(sku: string): string | null {
  const match1 = sku.match(/^DP-([A-Z0-9]{10})-[A-Z0-9]+$/)
  if (match1) return match1[1]
  const match2 = sku.match(/^DP([A-Z0-9]{10})[A-Z0-9]{1,4}$/)
  if (match2) return match2[1]
  return null
}

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
  internal_sku: string
  ebay_item_id:          string | null
  ebay_title:            string | null
  ebay_price:            string | null
  ebay_quantity:         number | null
  ebay_price_synced_at:  string | null
  image_url:             string | null
  source_url:            string | null
}

/**
 * Yalnızca store_catalog_state + isteğe bağlı amazon_product_cache (maliyet).
 */
export async function getMonitorListings(
  workspaceId: string,
  storeCode:   string,
  offset:      number,
  limit:       number
): Promise<MonitorListingsResult> {
  const generatedAt = new Date().toISOString()
  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error("Active store not found")

  const safeLimit  = Math.max(1, Math.min(200, limit))
  const safeOffset = Math.max(0, offset)

  const statsRes = await query<{ total: string; tracked: string; untracked: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (
         WHERE ebay_item_id IS NOT NULL AND trim(ebay_item_id::text) <> ''
       )::text AS tracked,
       COUNT(*) FILTER (
         WHERE ebay_item_id IS NULL OR trim(ebay_item_id::text) = ''
       )::text AS untracked
     FROM store_catalog_state
     WHERE workspace_id = $1 AND store_id = $2`,
    [workspaceId, store.id]
  )
  const stats = statsRes.rows[0]
  const total = parseInt(stats?.total ?? "0", 10) || 0
  const tracked = parseInt(stats?.tracked ?? "0", 10) || 0
  const untracked = parseInt(stats?.untracked ?? "0", 10) || 0

  const listRes = await query<CatalogListRow>(
    `SELECT internal_sku,
            ebay_item_id,
            ebay_title,
            ebay_price::text AS ebay_price,
            ebay_quantity,
            ebay_price_synced_at::text AS ebay_price_synced_at,
            image_url,
            source_url
     FROM store_catalog_state
     WHERE workspace_id = $1 AND store_id = $2
     ORDER BY updated_at DESC
     LIMIT $3 OFFSET $4`,
    [workspaceId, store.id, safeLimit, safeOffset]
  )

  const asinSet = new Set<string>()
  for (const r of listRes.rows) {
    const a = parseAsinFromSku(r.internal_sku?.trim() ?? "")
    if (a) asinSet.add(a)
  }
  const costMap = await fetchAmazonCostsByAsins(workspaceId, [...asinSet])

  const items: MonitorItem[] = listRes.rows.map(row => {
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

    const asin = parseAsinFromSku(sku)
    const cost = asin ? (costMap.get(asin) ?? null) : null
    const margin =
      cost !== null && ebayPrice > 0 && Number.isFinite(cost)
        ? Math.round(((ebayPrice - cost) / ebayPrice) * 100 * 100) / 100
        : null

    return {
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
    }
  })

  const totalPages = Math.max(1, Math.ceil(total / safeLimit))
  const currentPage = Math.min(
    totalPages,
    Math.floor(safeOffset / safeLimit) + 1
  )

  return {
    store:              store.name?.trim() || "Store",
    total,
    ebayInventoryTotal: total,
    tracked,
    untracked,
    simulationMode:     false,
    items,
    generatedAt,
    currentPage,
    totalPages,
  }
}
