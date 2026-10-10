// ----------------------------------------------------------------
// ordersSyncService.ts — fetch eBay orders and upsert into DB
//
// Window: first sync (no watermark) -> last 30 days.
//         subsequent syncs -> (lastSynced - 24h) so updated orders are not missed.
// Pulls by lastmodifieddate filter; upserts to ebay_orders/ebay_order_items.
// Listings (store_catalog_state) are only READ for image/match — never written.
// ----------------------------------------------------------------

import { EbayApiClient, type EbayOrderRow } from "../ebay/ebayApiClient"
import { getAccountStatus, getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import {
  getActiveStores,
  getLastSyncedAt,
  setLastSyncedAt,
  upsertOrders,
  type OrderStore,
} from "./ordersRepository"
import type { OrdersStoreError, OrdersSyncStoreResult } from "./ordersTypes"

const SYNC_PAGE_LIMIT = 200
const MAX_PAGES = 25
const FIRST_SYNC_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
const SAFETY_BACKTRACK_MS = 24 * 60 * 60 * 1000

/** Order fetch + restock eligibility window for sold-item auto-restock (24h). */
export const RECENT_ORDER_WINDOW_MS = 24 * 60 * 60 * 1000
export const RESTOCK_ORDER_WINDOW_MINUTES = 24 * 60
const RECENT_ORDER_MAX_PAGES = 5

function resolveSyncFrom(lastSynced: Date | null): Date {
  const now = Date.now()
  if (!lastSynced) return new Date(now - FIRST_SYNC_LOOKBACK_MS)
  return new Date(lastSynced.getTime() - SAFETY_BACKTRACK_MS)
}

async function fetchAllOrders(
  client:       EbayApiClient,
  modifiedFrom: string,
  maxPages = MAX_PAGES
): Promise<EbayOrderRow[]> {
  const collected: EbayOrderRow[] = []
  let offset = 0
  for (let page = 0; page < maxPages; page++) {
    const rows = await client.getOrders(SYNC_PAGE_LIMIT, offset, { modifiedFrom })
    collected.push(...rows)
    if (rows.length < SYNC_PAGE_LIMIT) break
    offset += rows.length
  }
  return collected
}

export type RecentOrdersSyncOutcome = {
  orders:         EbayOrderRow[]
  upsertedOrders: number
  upsertedItems:  number
  skipped:        boolean
  skipReason?:    string
}

/**
 * Fetch orders modified in the last `windowMs`, upsert to ebay_orders/ebay_order_items
 * (same path as manual order sync). Does NOT update ebay_order_sync_state watermark.
 */
export async function syncRecentOrdersForStore(
  workspaceId: string,
  store:       OrderStore,
  windowMs:    number = RECENT_ORDER_WINDOW_MS,
  maxPages:    number = RECENT_ORDER_MAX_PAGES
): Promise<RecentOrdersSyncOutcome> {
  const empty: RecentOrdersSyncOutcome = {
    orders:         [],
    upsertedOrders: 0,
    upsertedItems:  0,
    skipped:        false,
  }

  let connected = false
  try {
    const status = await getAccountStatus(workspaceId, store.storeCode)
    connected = status.connected === true
  } catch {
    connected = false
  }

  if (!connected) {
    return { ...empty, skipped: true, skipReason: "not_connected" }
  }

  let token: string
  try {
    token = await getValidAccessToken(workspaceId, store.storeCode, false)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ...empty, skipped: true, skipReason: `token_unavailable: ${msg}` }
  }

  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
  const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })
  const modifiedFrom = new Date(Date.now() - windowMs).toISOString()

  let orders: EbayOrderRow[] = []
  try {
    orders = await fetchAllOrders(client, modifiedFrom, maxPages)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ...empty, skipped: true, skipReason: `order_fetch_failed: ${msg}` }
  }

  if (orders.length === 0) {
    return empty
  }

  const { upsertedOrders, upsertedItems } = await upsertOrders(workspaceId, store, orders)
  return { orders, upsertedOrders, upsertedItems, skipped: false }
}

export type StoreSyncOutcome = {
  result: OrdersSyncStoreResult | null
  error:  OrdersStoreError | null
}

export async function syncOrdersForStore(
  workspaceId: string,
  store:       OrderStore
): Promise<StoreSyncOutcome> {
  let connected = false
  try {
    const status = await getAccountStatus(workspaceId, store.storeCode)
    connected = status.connected === true
  } catch {
    connected = false
  }

  if (!connected) {
    // Not connected is not a hard error; nothing to sync, screen keeps DB rows.
    return { result: null, error: null }
  }

  try {
    const token = await getValidAccessToken(workspaceId, store.storeCode, false)
    const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
    const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })

    const lastSynced = await getLastSyncedAt(workspaceId, store.id)
    const from = resolveSyncFrom(lastSynced)
    const orders = await fetchAllOrders(client, from.toISOString())

    const { upsertedOrders, upsertedItems } = await upsertOrders(workspaceId, store, orders)
    await setLastSyncedAt(workspaceId, store.id, new Date())

    return {
      result: {
        storeCode:      store.storeCode,
        storeName:      store.name,
        fetched:        orders.length,
        upsertedOrders,
        upsertedItems,
      },
      error: null,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn(`[Orders] store=${store.storeCode} sync failed: ${message}`)
    return {
      result: null,
      error: {
        storeCode: store.storeCode,
        storeName: store.name,
        message:   "eBay siparişleri alınamadı.",
      },
    }
  }
}

export async function syncOrdersForStores(
  workspaceId: string,
  stores:      OrderStore[]
): Promise<{ results: OrdersSyncStoreResult[]; errors: OrdersStoreError[] }> {
  const results: OrdersSyncStoreResult[] = []
  const errors: OrdersStoreError[] = []

  for (const store of stores) {
    const outcome = await syncOrdersForStore(workspaceId, store)
    if (outcome.result) results.push(outcome.result)
    if (outcome.error) errors.push(outcome.error)
  }

  return { results, errors }
}

export async function syncOrdersForAllStores(
  workspaceId: string
): Promise<{ results: OrdersSyncStoreResult[]; errors: OrdersStoreError[] }> {
  const stores = await getActiveStores(workspaceId)
  return syncOrdersForStores(workspaceId, stores)
}
