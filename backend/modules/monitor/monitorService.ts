// ─────────────────────────────────────────────────────────────
// monitorService.ts
//
// Flow:
//   1. eBay Inventory API → inventory_items + offers
//   2. SKU parse → ASIN çıkar (DP-{ASIN}-{STORE})
//   3. DB lookup → amazon_product_cache.price = cost
//   4. Margin = (ebayPrice - cost) / ebayPrice * 100
//   5. TRACKED / UNTRACKED flag
//
// simulationMode=true → fake eBay data, gerçek DB lookup
// simulationMode=false → gerçek eBay API
// ─────────────────────────────────────────────────────────────

import { query }            from "../../db/client"
import {
  EbayApiClient,
  type EbayActiveListingPriceRow,
  type EbayGetInventoryItemsPage,
  type EbayGetOffersPage,
} from "../ebay/ebayApiClient"
import type { EbayClientConfig } from "../ebay/ebayApiTypes"
import type {
  EbayGetInventoryItemsResponse,
  EbayGetOffersResponse,
  MonitorItem,
  MonitorListingsResult,
} from "./monitorTypes"

// ─── SKU PARSE ────────────────────────────────────────────────
// Format: DP-{ASIN}-{STORESCODE}
// Örnek:  DP-B0DSP542358511-S1 → B0DSP542358511

function parseAsinFromSku(sku: string): string | null {
  // Format 1: DP-B071251380-S1 (with dashes)
  const match1 = sku.match(/^DP-([A-Z0-9]{10})-[A-Z0-9]+$/)
  if (match1) return match1[1]
  // Format 2: DPB09WC25KKJS1 (no dashes) — ASIN always 10 chars
  const match2 = sku.match(/^DP([A-Z0-9]{10})[A-Z0-9]{1,4}$/)
  if (match2) return match2[1]
  return null
}

// ─── DB LOOKUP ────────────────────────────────────────────────

type DbRow = {
  asin:           string
  poolId:         number
  pipelineStage:  string
  amazonCost:     string | null
}

async function fetchDbRowsByAsins(
  workspaceId: string,
  asins:       string[]
): Promise<Map<string, DbRow>> {
  if (asins.length === 0) return new Map()

  const result = await query<{
    asin:           string
    pool_id:        number
    pipeline_stage: string
    amazon_cost:    string | null
  }>(
    `SELECT
       ar.asin,
       ap.id           AS pool_id,
       ap.pipeline_stage,
       apc.price::text AS amazon_cost
     FROM asin_pool ap
     INNER JOIN asin_registry ar  ON ar.id  = ap.asin_registry_id
     LEFT  JOIN amazon_product_cache apc ON apc.asin_registry_id = ap.asin_registry_id
     WHERE ap.workspace_id = $1
       AND ar.asin = ANY($2::text[])`,
    [workspaceId, asins]
  )

  const map = new Map<string, DbRow>()
  for (const r of result.rows) {
    map.set(r.asin, {
      asin:          r.asin,
      poolId:        r.pool_id,
      pipelineStage: r.pipeline_stage,
      amazonCost:    r.amazon_cost,
    })
  }
  return map
}

type AsinStoreMeta = { ebayItemId: string | null; listedAt: string | null }

/**
 * store_catalog_state + listing_history: ebay_item_id ve en iyi listed_at (daha geç olan kazanır).
 */
async function fetchAsinStoreMetaByAsins(
  workspaceId: string,
  storeId:     number,
  asins:       string[]
): Promise<Map<string, AsinStoreMeta>> {
  const map = new Map<string, AsinStoreMeta>()
  if (asins.length === 0) return map

  const scRows = await query<{
    asin:           string
    ebay_item_id:   string | null
    listed_at:      string | null
  }>(
    `SELECT ar.asin, scs.ebay_item_id, scs.listed_at::text AS listed_at
     FROM store_catalog_state scs
     INNER JOIN asin_registry ar ON ar.id = scs.asin_registry_id
     WHERE scs.workspace_id = $1 AND scs.store_id = $2 AND ar.asin = ANY($3::text[])`,
    [workspaceId, storeId, asins]
  )

  for (const r of scRows.rows) {
    map.set(r.asin, {
      ebayItemId: r.ebay_item_id?.trim() || null,
      listedAt:   r.listed_at?.trim() || null,
    })
  }

  const lhRows = await query<{ asin: string; max_listed: string | null }>(
    `SELECT ar.asin, (MAX(lh.listed_at))::text AS max_listed
     FROM listing_history lh
     INNER JOIN asin_registry ar ON ar.id = lh.asin_registry_id
     WHERE lh.workspace_id = $1 AND lh.store_id = $2 AND ar.asin = ANY($3::text[])
     GROUP BY ar.asin`,
    [workspaceId, storeId, asins]
  )

  for (const r of lhRows.rows) {
    const lhIso = r.max_listed?.trim() || null
    if (!lhIso) continue
    const prev  = map.get(r.asin)
    const tPrev = prev?.listedAt ? Date.parse(prev.listedAt) : -1
    const tLh   = Date.parse(lhIso)
    if (tLh > tPrev) {
      map.set(r.asin, {
        ebayItemId: prev?.ebayItemId ?? null,
        listedAt:   lhIso,
      })
    } else if (!prev) {
      map.set(r.asin, { ebayItemId: null, listedAt: lhIso })
    }
  }

  return map
}

// ─── STORE LOOKUP ─────────────────────────────────────────────

async function getStoreByCode(
  workspaceId: string,
  storeCode:   string
): Promise<{ id: number; name: string; storeCode: string; ebayToken: string | null } | null> {
  const result = await query<{
    id:         number
    name:       string
    store_code: string
  }>(
    `SELECT id, name, store_code FROM stores
     WHERE workspace_id = $1 AND store_code = $2 AND status = 'active' LIMIT 1`,
    [workspaceId, storeCode]
  )
  if (!result.rows[0]) return null
  const r = result.rows[0]
  return { id: r.id, name: r.name, storeCode: r.store_code, ebayToken: null }
}

// ─── ASSIGNED ASINS ────────────────────────────────────────────

async function fetchAssignedAsins(
  workspaceId: string,
  storeId: number
): Promise<string[]> {
  const result = await query<{ asin: string }>(
    `SELECT ar.asin
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id = $1
       AND ap.assigned_store_id = $2`,
    [workspaceId, storeId]
  )
  return result.rows.map(r => r.asin.toUpperCase())
}

function buildDpSku(asin: string, storeCode: string): string {
  // New format (alphanumeric, no dashes): DP{ASIN}{STORECODE}
  return `DP${asin}${storeCode}`.toUpperCase()
}

// ─── EBAY API FETCH ───────────────────────────────────────────

// fetchEbayInventoryItems and fetchEbayOffers handled via EbayApiClient methods

// ─── SIMULATION DATA ──────────────────────────────────────────
// simulationMode=true iken gerçek eBay'e gitmez,
// DB'deki mevcut pool kayıtlarından sahte listing üretir.

async function buildSimulatedEbayData(
  workspaceId: string,
  storeCode:   string,
  storeId:     number
): Promise<{ skus: string[]; priceMap: Map<string, number>; titleMap: Map<string, string>; qtyMap: Map<string, number>; imageMap: Map<string, string | null> }> {
  const result = await query<{
    asin:       string
    title:      string | null
    pool_id:    number
    amazon_cost: string | null
  }>(
    `SELECT ar.asin, COALESCE(aic.title, apc.title, ar.title) AS title,
            ap.id AS pool_id, apc.price::text AS amazon_cost
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     LEFT  JOIN amazon_product_cache apc ON apc.asin_registry_id = ap.asin_registry_id
     LEFT  JOIN ai_listing_cache aic
       ON aic.workspace_id = ap.workspace_id AND aic.asin_registry_id = ap.asin_registry_id
     WHERE ap.workspace_id = $1 AND ap.assigned_store_id = $2
     LIMIT 100`,
    [workspaceId, storeId]
  )

  const skus:     string[]                 = []
  const priceMap: Map<string, number>      = new Map()
  const titleMap: Map<string, string>      = new Map()
  const qtyMap:   Map<string, number>      = new Map()
  const imageMap: Map<string, string|null> = new Map()

  for (const r of result.rows) {
    const sku  = `DP-${r.asin}-${storeCode}`
    const cost = r.amazon_cost ? parseFloat(r.amazon_cost) : 29.99
    // Simulate price = cost * 1.35
    const price = Math.round(cost * 1.35 * 100) / 100

    skus.push(sku)
    priceMap.set(sku, price)
    titleMap.set(sku, r.title ?? `Product ${r.asin}`)
    qtyMap.set(sku, 1)
    imageMap.set(sku, `https://example.com/images/${r.asin}-1.jpg`)
  }

  // Add some UNTRACKED items for realism
  const untrackedAsins = ["B0UNTRACK001", "B0UNTRACK002", "B0UNTRACK003"]
  for (const asin of untrackedAsins) {
    const sku = `MANUAL-${asin}`
    skus.push(sku)
    priceMap.set(sku, 34.99)
    titleMap.set(sku, `Manual Listing ${asin}`)
    qtyMap.set(sku, 2)
    imageMap.set(sku, null)
  }

  return { skus, priceMap, titleMap, qtyMap, imageMap }
}

// ─── MAIN SERVICE ─────────────────────────────────────────────

export async function getMonitorListings(
  workspaceId: string,
  storeCode:   string,
  ebayConfig:  EbayClientConfig,
  offset?:     number,
  limit?:      number
): Promise<MonitorListingsResult> {
  const generatedAt = new Date().toISOString()

  // 1. Store bul
  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error(`Active store not found: "${storeCode}"`)

  const simMode = ebayConfig.simulationMode ?? true

  // 2. eBay verilerini al
  let skus:                string[]
  let priceMap:            Map<string, number>
  let titleMap:            Map<string, string>
  let qtyMap:              Map<string, number>
  let imageMap:            Map<string, string | null>
  let listingIdBySku      = new Map<string, string>()
  let ebayInventoryTotal  = 0

  if (simMode) {
    const sim = await buildSimulatedEbayData(workspaceId, storeCode, store.id)
    skus     = sim.skus
    priceMap = sim.priceMap
    titleMap = sim.titleMap
    qtyMap   = sim.qtyMap
    imageMap = sim.imageMap
    ebayInventoryTotal = skus.length
  } else {
    const apiClient = new EbayApiClient(ebayConfig)
    // 1) DB'den bu store'a atanmış ASIN'leri çek
    const assignedAsins = await fetchAssignedAsins(workspaceId, store.id)
    const assignedSkus  = assignedAsins.map(asin => buildDpSku(asin, storeCode))

    // 2) Tüm inventory'i pagination ile çek (getInventoryItems artık tüm sayfaları topluyor, max ~1000)
    const invRes = await apiClient.getInventoryItems(200)
    const inventoryItems = invRes.inventoryItems ?? []
    ebayInventoryTotal = typeof invRes.total === "number" ? invRes.total : inventoryItems.length
    const invMap = new Map(inventoryItems.map((i: EbayGetInventoryItemsPage["inventoryItems"][0]) => [i.sku, i]))

    // 3) Fiyat / listingId / stok — hata olursa sessizce boş (fiyat 0)
    let publishedRows: EbayActiveListingPriceRow[] = []
    try {
      publishedRows = await apiClient.getActiveListingPrices()
    } catch {
      publishedRows = []
    }
    const offerMap = new Map<string, EbayGetOffersPage["offers"][0]>()
    const priceBySku = new Map<string, number>()
    for (const r of publishedRows) {
      priceBySku.set(r.sku, r.price)
      offerMap.set(r.sku, {
        sku:               r.sku,
        offerId:           r.offerId,
        pricingSummary:    { price: { value: String(r.price), currency: r.currency } },
        availableQuantity: r.availableQuantity,
        listing:           r.listingId ? { listingId: r.listingId } : undefined,
        status:            "PUBLISHED",
      })
    }

    skus = [...new Set([...assignedSkus, ...invMap.keys(), ...offerMap.keys()])] as string[]
    priceMap = new Map()
    titleMap = new Map()
    qtyMap   = new Map()
    imageMap = new Map()

    for (const sku of skus) {
      const inv   = invMap.get(sku)
      const offer = offerMap.get(sku)

      const priceStr = offer?.pricingSummary?.price?.value
      priceMap.set(
        sku,
        priceBySku.has(sku) ? priceBySku.get(sku)! : (priceStr ? parseFloat(priceStr) : 0)
      )
      titleMap.set(sku, inv?.product?.title ?? "")
      qtyMap.set(sku, offer?.availableQuantity ?? inv?.availability?.shipToLocationAvailability?.quantity ?? 0)
      imageMap.set(sku, inv?.product?.imageUrls?.[0] ?? null)

      const lid = offer?.listing?.listingId?.trim()
      if (lid) listingIdBySku.set(sku, lid)
    }
  }

  // 3. ASIN'leri parse et
  const asinList = skus
    .map(sku => parseAsinFromSku(sku))
    .filter((a): a is string => a !== null)

  // 4. DB lookup
  const dbMap         = await fetchDbRowsByAsins(workspaceId, asinList)
  const asinStoreMeta = await fetchAsinStoreMetaByAsins(workspaceId, store.id, asinList)

  // 5. Monitor items oluştur
  const items: MonitorItem[] = skus.map(sku => {
    const asin      = parseAsinFromSku(sku)
    const dbRow     = asin ? dbMap.get(asin) : undefined
    const meta      = asin ? asinStoreMeta.get(asin) : undefined
    const ebayPrice = priceMap.get(sku) ?? 0
    const cost      = dbRow?.amazonCost ? parseFloat(dbRow.amazonCost) : null
    const margin    = (cost !== null && ebayPrice > 0)
      ? Math.round(((ebayPrice - cost) / ebayPrice) * 100 * 100) / 100
      : null

    const apiListingId = listingIdBySku.get(sku)?.trim()
    const catalogId    = meta?.ebayItemId?.trim()
    const ebayItemId   = apiListingId || catalogId || null
    const listedAt     = meta?.listedAt ?? null

    return {
      sku,
      title:      titleMap.get(sku) ?? "",
      image:      imageMap.get(sku) ?? null,
      ebayPrice,
      quantity:   qtyMap.get(sku) ?? 0,
      cost,
      margin,
      asin:       asin ?? null,
      ebayItemId,
      listedAt,
      status:     dbRow ? "TRACKED" : "UNTRACKED",
      poolId:     dbRow?.poolId ?? null,
      stage:      dbRow?.pipelineStage ?? null,
    }
  })

  const trackedStatusCount   = items.filter(i => i.status === "TRACKED").length
  const untrackedStatusCount = items.filter(i => i.status === "UNTRACKED").length

  const tracked = items.filter(i => i.asin !== null && i.listedAt !== null)
  const untracked = items.filter(i => i.asin === null || i.listedAt === null)
  tracked.sort((a, b) => {
    const ta = a.listedAt ? Date.parse(a.listedAt) : 0
    const tb = b.listedAt ? Date.parse(b.listedAt) : 0
    return tb - ta
  })
  const sorted = [...tracked, ...untracked]

  const usePaging = limit !== undefined
  let pagedItems   = sorted
  let currentPage  = 1
  let totalPages   = 1

  if (usePaging) {
    const safeLimit = Math.max(1, Math.min(limit!, 200))
    const start     = Math.max(0, offset ?? 0)
    totalPages      = Math.max(1, Math.ceil(sorted.length / safeLimit))
    const rawPage   = Math.floor(start / safeLimit) + 1
    currentPage     = Math.min(Math.max(rawPage, 1), totalPages)
    pagedItems      = start >= sorted.length ? [] : sorted.slice(start, start + safeLimit)
  }

  return {
    store:              storeCode,
    total:              sorted.length,
    ebayInventoryTotal,
    tracked:            trackedStatusCount,
    untracked:          untrackedStatusCount,
    simulationMode:     simMode,
    items:              pagedItems,
    generatedAt,
    currentPage,
    totalPages,
  }
}
