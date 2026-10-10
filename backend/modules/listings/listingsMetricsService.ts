import { query } from "../../db/client"
import { getAccountStatus, getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import { EbayApiClient } from "../ebay/ebayApiClient"
import {
  fetchClicks30dSyncStatusByStoreCode,
  recordMetricsSyncComplete,
} from "../storeSync/storeSyncScheduleService"
import type {
  ListingMetricsSnapshot,
  SyncMetricsItemResult,
  SyncMetricsRequest,
  SyncMetricsResponse,
} from "./listingsMetricsTypes"

type StoreRow = { id: number; name: string; workspace_id: string }

type CatalogStats = { total: number; withEbayItemId: number }

async function getStoreByCode(
  workspaceId: string,
  storeCode:   string
): Promise<StoreRow | null> {
  const result = await query<StoreRow>(
    `SELECT id, name, workspace_id FROM stores
     WHERE workspace_id = $1 AND store_code = $2 AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  return result.rows[0] ?? null
}

async function fetchCatalogStats(
  workspaceId: string,
  storeId:     number
): Promise<CatalogStats> {
  const result = await query<{ total: string; with_ebay: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (
              WHERE ebay_item_id IS NOT NULL AND trim(ebay_item_id::text) <> ''
            )::text AS with_ebay
     FROM store_catalog_state
     WHERE workspace_id = $1 AND store_id = $2`,
    [workspaceId, storeId]
  )
  const row = result.rows[0]
  return {
    total:          parseInt(row?.total ?? "0", 10) || 0,
    withEbayItemId: parseInt(row?.with_ebay ?? "0", 10) || 0,
  }
}

function buildSyncHint(input: {
  catalogStats:      CatalogStats
  tradingCount:      number
  updated:           number
  notFound:          number
  analyticsAvailable: boolean
  analyticsError:    string | null
  accountExpired:    boolean
  accountConnected:  boolean
}): string | null {
  if (!input.accountConnected) {
    return "No eBay account connected for this store — connect in Settings"
  }
  if (input.accountExpired) {
    return "eBay token expired — reconnect or refresh token in Settings"
  }
  if (input.catalogStats.withEbayItemId === 0) {
    return "No catalog rows with eBay item IDs for this store"
  }
  if (input.tradingCount === 0 && input.updated === 0) {
    return "Trading sync returned 0 items from eBay for this store's account"
  }
  if (!input.analyticsAvailable && input.analyticsError?.toLowerCase().includes("scope")) {
    if (input.updated === 0) {
      return "Analytics scope missing — clicks/views unavailable; sold/watch may still sync"
    }
  }
  if (input.updated === 0 && input.notFound > 0) {
    return `${input.notFound} eBay listing(s) did not match catalog rows in this store`
  }
  return null
}

function chunkIds(ids: string[], size: number): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

function normalizeIds(ids: string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids ?? []) {
    const id = String(raw ?? "").trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export async function updateListingMetrics(
  workspaceId: string,
  storeId:     number,
  snap:        ListingMetricsSnapshot
): Promise<boolean> {
  const before = await query<{ id: string; total_sold: string | null; sold_30d: string | null }>(
    `SELECT id::text, total_sold::text, sold_30d::text
     FROM store_catalog_state
     WHERE workspace_id = $1
       AND store_id = $2
       AND trim(ebay_item_id) = $3
     LIMIT 1`,
    [workspaceId, storeId, snap.listingId]
  )
  const soldBefore =
    Number(before.rows[0]?.total_sold ?? 0) > 0 || Number(before.rows[0]?.sold_30d ?? 0) > 0
  const result = await query<{ id: string }>(
    `UPDATE store_catalog_state
     SET total_sold         = $4,
         watch_count        = $5,
         clicks_30d         = COALESCE($6::integer, clicks_30d),
         views_30d          = $7,
         impressions_30d    = $8,
         listed_at          = CASE WHEN $9::timestamptz IS NOT NULL THEN $9::timestamptz ELSE listed_at END,
         metrics_synced_at  = NOW(),
         metrics_source     = $10,
         metrics_error      = $11,
         updated_at         = NOW()
     WHERE workspace_id = $1
       AND store_id = $2
       AND trim(ebay_item_id) = $3
     RETURNING id::text`,
    [
      workspaceId,
      storeId,
      snap.listingId,
      snap.totalSold,
      snap.watchCount,
      snap.clicks30d,
      snap.views30d,
      snap.impressions30d,
      snap.listedAt,
      snap.metricsSource,
      snap.metricsError,
    ]
  )
  const catalogStateId = Number(result.rows[0]?.id)
  const soldAfter = Number(snap.totalSold ?? 0) > 0 || Number(before.rows[0]?.sold_30d ?? 0) > 0
  if (Number.isFinite(catalogStateId) && soldBefore !== soldAfter) {
    const { emitKeepaAsinSyncForCatalog } = await import("../keepaSensor/keepaAsinSyncOutbox")
    await emitKeepaAsinSyncForCatalog({ workspaceId, storeId, catalogStateId }).catch(() => undefined)
  }
  return (result.rowCount ?? 0) > 0
}

export async function syncListingMetrics(
  workspaceId: string,
  req:         SyncMetricsRequest
): Promise<SyncMetricsResponse> {
  const storeCode = req.storeCode?.trim()
  if (!storeCode) throw new Error("storeCode is required")

  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error("Active store not found")

  const targetIds = normalizeIds(req.ebayItemIds)
  const syncAll = targetIds.length === 0

  let accountStatus
  try {
    accountStatus = await getAccountStatus(workspaceId, storeCode)
  } catch {
    accountStatus = {
      connected: false,
      expired:   true,
      ebayUserId: null as string | null,
    }
  }

  if (!accountStatus.connected) {
    throw new Error("No eBay account connected for this store")
  }

  const catalogStats = await fetchCatalogStats(workspaceId, store.id)

  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
  let token: string
  try {
    token = await getValidAccessToken(workspaceId, storeCode, false)
  } catch (e) {
    throw new Error(
      e instanceof Error ? e.message : "eBay token expired or unavailable"
    )
  }

  const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })

  const tradingByListing = new Map<string, ListingMetricsSnapshot>()
  let analyticsAvailable = false
  let analyticsError: string | null = null

  if (syncAll) {
    const rows = await client.fetchGetMyeBaySellingAllPages()
    for (const row of rows) {
      const listingId = row.listingId?.trim()
      if (!listingId) continue
      if (targetIds.length > 0 && !targetIds.includes(listingId)) continue
      tradingByListing.set(listingId, {
        listingId,
        totalSold:      row.quantitySold ?? null,
        watchCount:     row.watchCount ?? null,
        listedAt:       row.listedAt ?? null,
        clicks30d:      null,
        views30d:       null,
        impressions30d: null,
        metricsSource:  "ebay_trading",
        metricsError:   null,
      })
    }
  } else {
    for (const listingId of targetIds) {
      try {
        const m = await client.fetchGetItemListingMetrics(listingId)
        if (!m) continue
        tradingByListing.set(listingId, {
          listingId,
          totalSold:      m.quantitySold,
          watchCount:     m.watchCount,
          listedAt:       m.listedAt,
          clicks30d:      null,
          views30d:       null,
          impressions30d: null,
          metricsSource:  "ebay_trading",
          metricsError:   null,
        })
      } catch (e) {
        console.warn(`[MetricsSync] GetItem failed listingId=${listingId}:`, e)
      }
    }
  }

  const analyticsIds = syncAll
    ? [...tradingByListing.keys()]
    : targetIds

  if (!syncAll && analyticsIds.length > 0) {
    for (const batch of chunkIds(analyticsIds, 200)) {
      const traffic = await client.getTrafficReport30dByListings(batch)
      if (traffic.ok) {
        analyticsAvailable = true
        for (const row of traffic.rows) {
          const existing = tradingByListing.get(row.listingId)
          if (!existing) continue
          existing.clicks30d = row.clicks30d
          existing.metricsSource = "ebay_trading+analytics"
          existing.metricsError = null
        }
      } else {
        analyticsError = traffic.error ?? "Analytics unavailable"
        if (analyticsError.toLowerCase().includes("scope")) break
      }
    }
    if (!analyticsAvailable && analyticsError) {
      for (const snap of tradingByListing.values()) {
        snap.metricsError = analyticsError
      }
    }
  }

  const results: SyncMetricsItemResult[] = []
  let updated = 0
  let notFound = 0

  const processIds =
    targetIds.length > 0 ? targetIds : [...tradingByListing.keys()]

  if (processIds.length === 0) {
    const syncHint = buildSyncHint({
      catalogStats,
      tradingCount:       tradingByListing.size,
      updated:            0,
      notFound:           0,
      analyticsAvailable,
      analyticsError,
      accountExpired:     accountStatus.expired ?? false,
      accountConnected:   accountStatus.connected ?? false,
    })
    console.warn(
      `[MetricsSync] storeCode=${storeCode} store_id=${store.id} ebay_user_id=${accountStatus.ebayUserId ?? "none"} trading=0 catalog=${catalogStats.withEbayItemId} hint=${syncHint ?? "none"}`
    )
    return {
      ok: true,
      storeCode,
      processed: 0,
      updated: 0,
      notFound: 0,
      analyticsAvailable,
      analyticsError,
      syncHint,
      results: [],
    }
  }

  for (const listingId of processIds) {
    const snap = tradingByListing.get(listingId)
    if (!snap) {
      notFound++
      results.push({
        ebayItemId: listingId,
        status:     "NOT_FOUND",
        message:    "No metrics returned from eBay for this listing",
      })
      continue
    }

    const didUpdate = await updateListingMetrics(workspaceId, store.id, snap)
    if (didUpdate) {
      updated++
      results.push({ ebayItemId: listingId, status: "UPDATED" })
    } else {
      notFound++
      results.push({
        ebayItemId: listingId,
        status:     "NOT_FOUND",
        message:    "Listing not found in store_catalog_state",
      })
    }
  }

  const syncHint = buildSyncHint({
    catalogStats,
    tradingCount:       tradingByListing.size,
    updated,
    notFound,
    analyticsAvailable,
    analyticsError,
    accountExpired:     accountStatus.expired ?? false,
    accountConnected:   accountStatus.connected ?? false,
  })

  if (updated === 0) {
    console.warn(
      `[MetricsSync] storeCode=${storeCode} store_id=${store.id} ebay_user_id=${accountStatus.ebayUserId ?? "none"} trading=${tradingByListing.size} catalog=${catalogStats.withEbayItemId} processed=${processIds.length} notFound=${notFound} hint=${syncHint ?? "none"}`
    )
  } else {
    console.log(
      `[MetricsSync] store=${storeCode} store_id=${store.id} processed=${processIds.length} updated=${updated} analytics=${analyticsAvailable}`
    )
  }

  // 30D clicks: background store sync scheduler (24h). Manual: POST /admin/listings/sync-30d-clicks
  if (syncAll) {
    const clicksStatus = await fetchClicks30dSyncStatusByStoreCode(workspaceId, storeCode)
    if (clicksStatus) {
      analyticsAvailable = clicksStatus.analyticsScopeActive
      if (!clicksStatus.analyticsScopeActive) {
        analyticsError =
          "Analytics permission required — reconnect store (sell.analytics.readonly)"
      } else if (clicksStatus.clicks30dSyncStatus === "error" && clicksStatus.clicks30dSyncError) {
        analyticsError = clicksStatus.clicks30dSyncError
      }
    }
  }

  await recordMetricsSyncComplete(store.id)

  return {
    ok: true,
    storeCode,
    processed: processIds.length,
    updated,
    notFound,
    analyticsAvailable,
    analyticsError,
    syncHint,
    results,
  }
}
