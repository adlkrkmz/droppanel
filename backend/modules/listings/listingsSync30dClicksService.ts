import { query } from "../../db/client"
import { EbayApiClient } from "../ebay/ebayApiClient"
import {
  accountHasAnalyticsScope,
  getAccountStatus,
  getValidAccessToken,
} from "../ebayOAuth/ebayOAuthService"
import { refreshStockGuardPriorityAfterClicksSync } from "./clicks30dStockGuardPriority"
import type { Sync30dClicksResponse } from "./listingsSync30dClicksTypes"

const BATCH_SIZE = 200

type StoreRow = { id: number; name: string }

async function getStoreByCode(
  workspaceId: string,
  storeCode: string
): Promise<StoreRow | null> {
  const res = await query<StoreRow>(
    `SELECT id, name FROM stores
     WHERE workspace_id = $1::uuid AND store_code = $2 AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  return res.rows[0] ?? null
}

async function loadEligibleListingIds(
  workspaceId: string,
  storeId: number
): Promise<string[]> {
  const res = await query<{ ebay_item_id: string }>(
    `SELECT trim(scs.ebay_item_id) AS ebay_item_id
     FROM store_catalog_state scs
     WHERE scs.workspace_id = $1::uuid
       AND scs.store_id = $2::bigint
       AND scs.panel_hidden_at IS NULL
       AND scs.current_status = 'live'
       AND scs.ebay_item_id IS NOT NULL
       AND trim(scs.ebay_item_id) <> ''
       AND COALESCE(scs.ebay_quantity, 0) > 0
     ORDER BY scs.id`,
    [workspaceId, storeId]
  )
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of res.rows) {
    const id = r.ebay_item_id?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function chunk<T>(arr: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < arr.length; i += size) batches.push(arr.slice(i, i + size))
  return batches
}

function isAnalyticsPermissionApiError(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes("scope") ||
    m.includes("403") ||
    m.includes("forbidden") ||
    m.includes("access denied") ||
    m.includes("insufficient") ||
    m.includes("not authorized") ||
    m.includes("permission")
  )
}

async function updateClicksForListing(
  workspaceId: string,
  storeId: number,
  listingId: string,
  clicks30d: number,
  metricsError: string | null
): Promise<boolean> {
  try {
    const res = await query(
      `UPDATE store_catalog_state
       SET clicks_30d = $4::integer,
           clicks_30d_checked_at = NOW(),
           metrics_synced_at = NOW(),
           metrics_error = $5::text,
           metrics_source = CASE
             WHEN $5::text IS NULL THEN 'ebay_analytics_30d'
             ELSE metrics_source
           END,
           updated_at = NOW()
       WHERE workspace_id = $1::uuid
         AND store_id = $2::bigint
         AND trim(ebay_item_id) = $3`,
      [workspaceId, storeId, listingId, clicks30d, metricsError]
    )
    return (res.rowCount ?? 0) > 0
  } catch {
    const res = await query(
      `UPDATE store_catalog_state
       SET clicks_30d = $4::integer,
           metrics_synced_at = NOW(),
           metrics_error = $5::text,
           metrics_source = CASE
             WHEN $5::text IS NULL THEN 'ebay_analytics_30d'
             ELSE metrics_source
           END,
           updated_at = NOW()
       WHERE workspace_id = $1::uuid
         AND store_id = $2::bigint
         AND trim(ebay_item_id) = $3`,
      [workspaceId, storeId, listingId, clicks30d, metricsError]
    )
    return (res.rowCount ?? 0) > 0
  }
}

export async function sync30dClicksForStore(
  workspaceId: string,
  storeCodeRaw: string
): Promise<Sync30dClicksResponse> {
  const storeCode = storeCodeRaw.trim()
  if (!storeCode) throw new Error("storeCode is required")

  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error("Active store not found")

  const account = await getAccountStatus(workspaceId, storeCode)
  if (!account.connected) {
    throw new Error("No eBay account connected for this store")
  }

  if (!accountHasAnalyticsScope(account.scope ?? null)) {
    return {
      ok: false,
      storeCode,
      checked: 0,
      updated: 0,
      missingAnalyticsPermission: true,
      message:
        "Analytics permission required. Reconnect this store with analytics permission.",
    }
  }

  const listingIds = await loadEligibleListingIds(workspaceId, store.id)
  if (listingIds.length === 0) {
    return {
      ok: true,
      storeCode,
      checked: 0,
      updated: 0,
      missingAnalyticsPermission: false,
      message: "No eligible live listings with eBay item IDs",
    }
  }

  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
  const token = await getValidAccessToken(workspaceId, storeCode, false)
  const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })

  let checked = 0
  let updated = 0
  let missingAnalyticsPermission = false
  let analyticsApiError: string | null = null
  let lastError: string | null = null

  for (const batch of chunk(listingIds, BATCH_SIZE)) {
    const traffic = await client.getTrafficReport30dByListings(batch)
    if (!traffic.ok) {
      lastError = traffic.error ?? "Analytics API failed"
      if (isAnalyticsPermissionApiError(lastError)) {
        missingAnalyticsPermission = true
        break
      }
      analyticsApiError = lastError
      console.warn(`[Sync30dClicks] batch failed store=${storeCode} error=${lastError}`)
      continue
    }

    const byListing = new Map(traffic.rows.map(r => [r.listingId, r.clicks30d ?? 0]))

    for (const listingId of batch) {
      checked++
      const clicks = byListing.get(listingId) ?? 0
      const did = await updateClicksForListing(
        workspaceId,
        store.id,
        listingId,
        clicks,
        null
      )
      if (did) updated++
    }
  }

  if (missingAnalyticsPermission) {
    await query(
      `UPDATE store_catalog_state
       SET metrics_error = $3::text,
           updated_at = NOW()
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint
         AND panel_hidden_at IS NULL
         AND current_status = 'live'`,
      [
        workspaceId,
        store.id,
        "Analytics permission required. Reconnect this store with analytics permission.",
      ]
    )
    return {
      ok: false,
      storeCode,
      checked,
      updated,
      missingAnalyticsPermission: true,
      message:
        "Analytics permission required. Reconnect this store with analytics permission.",
    }
  }

  if ((analyticsApiError || lastError) && updated === 0) {
    const errMsg = analyticsApiError ?? lastError ?? "Analytics API failed"
    return {
      ok: false,
      storeCode,
      checked,
      updated,
      missingAnalyticsPermission: false,
      analyticsApiError: errMsg,
      message: errMsg,
    }
  }

  const message =
    updated > 0
      ? "30D clicks updated"
      : lastError
        ? `30D clicks sync partial: ${lastError}`
        : "30D clicks updated"

  console.log(
    `[Sync30dClicks] store=${storeCode} checked=${checked} updated=${updated} listings=${listingIds.length}`
  )

  if (checked > 0) {
    await refreshStockGuardPriorityAfterClicksSync(workspaceId, store.id)
  }

  return {
    ok: true,
    storeCode,
    checked,
    updated,
    missingAnalyticsPermission: false,
    analyticsApiError: analyticsApiError ?? null,
    message,
  }
}
