import { query } from "../../db/client"
import { getAccountStatus, getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import { EbayApiClient, EbayCatalogPaginationIncompleteError, type EbayActiveListingPriceRow, type EbayCatalogPaginationReceipt } from "../ebay/ebayApiClient"
import {
  recordCatalogSyncComplete,
  recordCatalogSyncFailed,
  tryClaimCatalogSyncOwnership,
} from "../storeSync/storeSyncScheduleService"
import type { SyncListingsResponse } from "./listingsSyncTypes"

type StoreRow = { id: number; name: string; store_code: string; workspace_id: string }

/**
 * Conservative DB write concurrency for catalog upserts.
 * Pool max=20; each upsert is multiple short connect/release queries.
 * Limit 2 leaves headroom for API / Orders / Amazon worker / other stores.
 */
const CATALOG_DB_WRITE_CONCURRENCY = 2

/** In-process same-store guard (complements DB sync_status ownership). */
const activeCatalogSyncByStoreId = new Set<number>()

export function reconciliationEligibility(receipt: EbayCatalogPaginationReceipt): { eligible: boolean; reason: string | null } {
  const complete = receipt.paginationCompleted && receipt.fetchErrorCount === 0 &&
    receipt.expectedTotalPages !== null && receipt.lastCompletedPage >= receipt.expectedTotalPages &&
    receipt.pagesCompleted >= receipt.expectedTotalPages && receipt.totalsConsistent
  return complete
    ? { eligible: true, reason: null }
    : { eligible: false, reason: "RECONCILIATION_SKIPPED_INCOMPLETE_REMOTE_CATALOG" }
}

async function writeSyncReceipt(input: {
  workspaceId: string; store: StoreRow; startedAt: Date; status: "completed" | "incomplete" | "failed"
  receipt: EbayCatalogPaginationReceipt | null; reconciliationEligible: boolean; reconciliationRan: boolean
  reconciliationEndedCount: number; errorMessage: string | null
}): Promise<void> {
  const r = input.receipt
  await query(
    `INSERT INTO ebay_catalog_sync_receipts (
       workspace_id, store_id, store_code, started_at, completed_at, status,
       expected_total_entries, expected_total_pages, requested_page_size, pages_attempted,
       pages_completed, last_completed_page, fetched_row_count, distinct_remote_item_count,
       duplicate_remote_item_count, fetch_error_count, first_error, pagination_completed,
       totals_consistent, reconciliation_eligible, reconciliation_ran, reconciliation_ended_count, error_message
     ) VALUES ($1::uuid,$2,$3,$4,NOW(),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [input.workspaceId, input.store.id, input.store.store_code, input.startedAt, input.status,
      r?.expectedTotalEntries ?? null, r?.expectedTotalPages ?? null, r?.requestedPageSize ?? 100,
      r?.pagesAttempted ?? 0, r?.pagesCompleted ?? 0, r?.lastCompletedPage ?? 0, r?.fetchedRowCount ?? 0,
      r?.distinctRemoteItemCount ?? 0, r?.duplicateRemoteItemCount ?? 0, r?.fetchErrorCount ?? 1,
      r?.firstError ?? input.errorMessage, r?.paginationCompleted ?? false, r?.totalsConsistent ?? false,
      input.reconciliationEligible, input.reconciliationRan, input.reconciliationEndedCount, input.errorMessage]
  )
}

async function getStoreByCode(
  workspaceId: string,
  storeCode:   string
): Promise<StoreRow | null> {
  const result = await query<StoreRow>(
    `SELECT id, name, store_code, workspace_id FROM stores
     WHERE workspace_id = $1 AND store_code = $2 AND status = 'active'
     ORDER BY id ASC
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  return result.rows[0] ?? null
}

async function getStoreById(
  workspaceId: string,
  storeId:     number
): Promise<StoreRow | null> {
  if (!Number.isInteger(storeId) || storeId < 1) return null
  const result = await query<StoreRow>(
    `SELECT id, name, store_code, workspace_id FROM stores
     WHERE workspace_id = $1 AND id = $2 AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeId]
  )
  return result.rows[0] ?? null
}

function isGlobalSkuConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes("23505") ||
    msg.toLowerCase().includes("duplicate key") ||
    msg.includes("store_catalog_state_workspace_id_internal_sku")
  )
}

/**
 * Lifetime QuantitySold from Trading. Finite numbers (including 0) are authoritative.
 * null/undefined = field absent → do not overwrite existing total_sold on UPDATE.
 */
function resolveQuantitySold(row: EbayActiveListingPriceRow): number | null {
  if (typeof row.quantitySold !== "number" || !Number.isFinite(row.quantitySold)) {
    return null
  }
  return Math.max(0, Math.trunc(row.quantitySold))
}

/** Bounded parallel map — never launches more than `limit` workers. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const n = Math.max(1, Math.min(limit, items.length || 1))
  let next = 0
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      await worker(items[i]!)
    }
  })
  await Promise.all(runners)
}

/**
 * Upsert one Trading row into store_catalog_state for the target store only.
 * Match order: store_id + ebay_item_id → store_id + internal_sku → INSERT.
 * Never updates rows belonging to another store_id.
 * Preserves asin_registry_id, source_url, stock_guard_enabled,
 * Stock Guard / bot_zeroed / Keepa / Profit Protection and other internal metadata.
 * Confirmed ActiveList/live observation clears panel_hidden_at + last_seen_ended_at
 * so previously reconcile-hidden rows become visible again in the panel.
 * Persists SellingStatus.QuantitySold → total_sold when eBay provides a numeric value (incl. 0).
 */
async function upsertTradingRow(
  workspaceId: string,
  storeId:     number,
  row:         EbayActiveListingPriceRow
): Promise<"inserted" | "updated" | "skipped"> {
  const itemId = row.listingId?.trim() || null
  const internalSku = (row.sku ?? "").trim() || itemId
  if (!internalSku) return "skipped"

  const price = row.currentPrice ?? row.price ?? null
  const quantity = row.quantityAvailable ?? row.availableQuantity ?? null
  const title = row.title?.trim() || null
  const imageUrl = row.imageUrl?.trim() || null
  const listedAt = row.listedAt?.trim() || null
  const totalSold = resolveQuantitySold(row)
  const hasSold = totalSold !== null

  const offerId = row.offerId?.trim() || null
  const ebayFields = [
    price,
    quantity,
    title,
    imageUrl,
    listedAt,
  ] as const

  if (itemId) {
    const byItem = await query<{ id: number }>(
      `UPDATE store_catalog_state
       SET internal_sku         = $4,
           ebay_offer_id        = COALESCE(NULLIF(trim($12), ''), ebay_offer_id),
           ebay_price           = $5,
           ebay_quantity        = CASE
             WHEN $6::int IS NULL THEN ebay_quantity
             WHEN $6::int = 0 AND COALESCE(ebay_quantity, 0) > 0 THEN ebay_quantity
             ELSE $6
           END,
           ebay_title           = $7,
           image_url            = $8,
           listed_at            = COALESCE($9::timestamptz, listed_at),
           total_sold           = CASE WHEN $10::boolean THEN $11::integer ELSE total_sold END,
           ebay_price_synced_at = NOW(),
           current_status       = 'live',
           panel_hidden_at      = NULL,
           last_seen_ended_at   = NULL,
           last_seen_live_at    = NOW(),
           last_sync_at         = NOW(),
           updated_at           = NOW()
       WHERE workspace_id = $1
         AND store_id = $2
         AND trim(ebay_item_id) = $3
       RETURNING id`,
      [workspaceId, storeId, itemId, internalSku, ...ebayFields, hasSold, totalSold, offerId]
    )
    if ((byItem.rowCount ?? 0) > 0) {
      const id = Number(byItem.rows[0]?.id)
      if (Number.isFinite(id)) {
        await emitKeepaAfterCatalogChange({ workspaceId, storeId, catalogStateId: id })
      }
      return "updated"
    }
  }

  const bySku = await query<{ id: number }>(
    `UPDATE store_catalog_state
     SET ebay_item_id         = COALESCE($4, ebay_item_id),
         ebay_offer_id        = COALESCE(NULLIF(trim($12), ''), ebay_offer_id),
         ebay_price           = $5,
         ebay_quantity        = CASE
           WHEN $6::int IS NULL THEN ebay_quantity
           WHEN $6::int = 0 AND COALESCE(ebay_quantity, 0) > 0 THEN ebay_quantity
           ELSE $6
         END,
         ebay_title           = $7,
         image_url            = $8,
         listed_at            = COALESCE($9::timestamptz, listed_at),
         total_sold           = CASE WHEN $10::boolean THEN $11::integer ELSE total_sold END,
         ebay_price_synced_at = NOW(),
         current_status       = 'live',
         panel_hidden_at      = NULL,
         last_seen_ended_at   = NULL,
         last_seen_live_at    = NOW(),
         last_sync_at         = NOW(),
         updated_at           = NOW()
     WHERE workspace_id = $1
       AND store_id = $2
       AND internal_sku = $3
     RETURNING id`,
    [workspaceId, storeId, internalSku, itemId, ...ebayFields, hasSold, totalSold, offerId]
  )
  if ((bySku.rowCount ?? 0) > 0) {
    const id = Number(bySku.rows[0]?.id)
    if (Number.isFinite(id)) {
      await emitKeepaAfterCatalogChange({ workspaceId, storeId, catalogStateId: id })
    }
    return "updated"
  }

  const inserted = await query<{ id: number }>(
    `INSERT INTO store_catalog_state (
       workspace_id,
       store_id,
       asin_registry_id,
       internal_sku,
       ebay_item_id,
       ebay_offer_id,
       ebay_price,
       ebay_quantity,
       ebay_title,
       image_url,
       total_sold,
       ebay_price_synced_at,
       current_status,
       listed_at,
       last_seen_live_at,
       last_sync_at,
       source_of_truth,
       created_at,
       updated_at
     )
     VALUES ($1, $2, NULL, $3, $4, $11, $5, $6, $7, $8, $10, NOW(), 'live', $9::timestamptz, NOW(), NOW(), 'ebay_trading_sync', NOW(), NOW())
     RETURNING id`,
    [workspaceId, storeId, internalSku, itemId, price, quantity, title, imageUrl, listedAt, totalSold, offerId]
  )
  const newId = Number(inserted.rows[0]?.id)
  if (Number.isFinite(newId)) {
    await emitKeepaAfterCatalogChange({ workspaceId, storeId, catalogStateId: newId })
  }
  return "inserted"
}

export async function emitKeepaAfterCatalogChange(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
}): Promise<void> {
  try {
    const { trySyncGlobalAsinConsumerFromCatalog } = await import("../globalKeepa/globalAsinConsumerSync")
    await trySyncGlobalAsinConsumerFromCatalog(input)
  } catch {
    /* trading sync must still emit Keepa lifecycle independently */
  }
  try {
    const { emitKeepaAsinSyncForCatalog } = await import("../keepaSensor/keepaAsinSyncOutbox")
    await emitKeepaAsinSyncForCatalog(input)
  } catch {
    /* Keepa outbox must not fail eBay catalog sync */
  }
}

function buildSyncHint(input: {
  tradingRows:      number
  inserted:         number
  updated:          number
  errors:           number
  globalSkuBlocked: boolean
  accountConnected: boolean
  accountExpired:   boolean
}): string | null {
  if (!input.accountConnected) {
    return "No eBay account connected for this store — connect in Settings"
  }
  if (input.accountExpired) {
    return "eBay token expired — reconnect or refresh token in Settings"
  }
  if (input.tradingRows === 0) {
    return "Trading sync returned 0 active listings from eBay for this store's account"
  }
  if (input.globalSkuBlocked) {
    return "Some listings could not be inserted — same SKU exists in another store. Run migration 022_store_scoped_catalog_unique.sql to enable per-store SKU uniqueness."
  }
  if (input.inserted === 0 && input.updated === 0 && input.errors === 0) {
    return "No catalog changes were made"
  }
  if (input.errors > 0 && input.inserted + input.updated === 0) {
    return `${input.errors} listing(s) failed to sync — check backend logs`
  }
  return null
}

/** Hide catalog rows no longer active on eBay for this store (reconcile). */
async function reconcileEndedNotOnEbay(
  workspaceId: string,
  storeId:     number,
  activeIds:   string[]
): Promise<number> {
  if (activeIds.length === 0) return 0

  const result = await query<{ id: number }>(
    `UPDATE store_catalog_state
     SET current_status = 'ended',
         ebay_quantity = 0,
         panel_hidden_at = NOW(),
         last_seen_ended_at = NOW(),
         updated_at = NOW()
     WHERE workspace_id = $1
       AND store_id = $2
       AND panel_hidden_at IS NULL
       AND ebay_item_id IS NOT NULL
       AND trim(ebay_item_id) <> ''
       AND NOT (trim(ebay_item_id) = ANY($3::text[]))
     RETURNING id`,
    [workspaceId, storeId, activeIds]
  )
  const ids = result.rows.map(r => Number(r.id)).filter(id => Number.isFinite(id))
  if (ids.length > 0) {
    const { afterListingMonitoringStopped } = await import("../stockGuard/stockGuardV2LifecycleHooks")
    await afterListingMonitoringStopped({ workspaceId, catalogStateIds: ids })
    for (const catalogStateId of ids) {
      try {
        const { emitKeepaAsinSyncForCatalog } = await import("../keepaSensor/keepaAsinSyncOutbox")
        await emitKeepaAsinSyncForCatalog({ workspaceId, storeId, catalogStateId })
      } catch {
        /* ended-listing Keepa emit must not fail reconcile */
      }
    }
  }
  return result.rowCount ?? 0
}

/**
 * Pull active eBay listings (Trading GetMyeBaySelling) for one store and
 * insert/update store_catalog_state rows under that store_id only.
 * Canonical entry: exact store_id + workspace ownership.
 */
export async function syncListingsForStoreId(
  workspaceId: string,
  storeId:     number
): Promise<SyncListingsResponse> {
  const store = await getStoreById(workspaceId, storeId)
  if (!store) throw new Error("Active store not found")
  return runListingsSyncForStore(workspaceId, store)
}

/**
 * Legacy storeCode entry (scheduler / older callers). Prefer syncListingsForStoreId.
 */
export async function syncListingsForStore(
  workspaceId: string,
  storeCode:   string
): Promise<SyncListingsResponse> {
  const code = storeCode.trim()
  if (!code) throw new Error("storeCode is required")

  const store = await getStoreByCode(workspaceId, code)
  if (!store) throw new Error("Active store not found")
  return runListingsSyncForStore(workspaceId, store)
}

async function runListingsSyncForStore(
  workspaceId: string,
  store:       StoreRow
): Promise<SyncListingsResponse> {
  const code = store.store_code

  if (activeCatalogSyncByStoreId.has(store.id)) {
    throw new Error(`Catalog sync already running for store_id=${store.id}`)
  }

  const claimed = await tryClaimCatalogSyncOwnership(store.id)
  if (!claimed) {
    throw new Error(`Catalog sync already running for store_id=${store.id}`)
  }

  activeCatalogSyncByStoreId.add(store.id)
  const startedAt = new Date()
  let paginationReceipt: EbayCatalogPaginationReceipt | null = null

  try {
    let accountStatus
    try {
      accountStatus = await getAccountStatus(workspaceId, code)
    } catch {
      accountStatus = { connected: false, expired: true, ebayUserId: null as string | null }
    }

    if (!accountStatus.connected) {
      throw new Error("No eBay account connected for this store")
    }

    const token = await getValidAccessToken(workspaceId, code, false)
    const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
    const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })

    let inserted = 0
    let updated = 0
    let skipped = 0
    let errors = 0
    let globalSkuBlocked = false
    let tradingRows = 0
    const activeEbayIds: string[] = []

    const completedReceipt = await client.forEachGetMyeBaySellingPage(async pageRows => {
      tradingRows += pageRows.length
      for (const row of pageRows) {
        const id = row.listingId?.trim()
        if (id) activeEbayIds.push(id)
      }

      await mapWithConcurrency(pageRows, CATALOG_DB_WRITE_CONCURRENCY, async row => {
        try {
          const outcome = await upsertTradingRow(workspaceId, store.id, row)
          if (outcome === "inserted") inserted++
          else if (outcome === "updated") updated++
          else skipped++
        } catch (e) {
          errors++
          if (isGlobalSkuConflict(e)) {
            globalSkuBlocked = true
            console.warn(
              `[ListingsSync] store=${code} store_id=${store.id} global SKU conflict sku=${row.sku?.trim() ?? row.listingId} — run migration 022`
            )
          } else {
            console.error(
              `[ListingsSync] store=${code} store_id=${store.id} failed sku=${row.sku?.trim() ?? "?"}:`,
              e
            )
          }
        }
      })

      // Keep ownership heartbeat so stale recovery does not kill a live large-store sync.
      await query(
        `UPDATE stores SET updated_at = NOW() WHERE id = $1 AND sync_status = 'catalog_running'`,
        [store.id]
      ).catch(() => undefined)
    })

    paginationReceipt = completedReceipt
    let reconciled = 0
    const reconciliation = reconciliationEligibility(completedReceipt)
    if (reconciliation.eligible) {
      try {
        reconciled = await reconcileEndedNotOnEbay(workspaceId, store.id, activeEbayIds)
        if (reconciled > 0) {
          console.log(
            `[ListingsSync] store=${code} store_id=${store.id} reconciled=${reconciled} ended-not-on-ebay`
          )
        }
      } catch (e) {
        console.error(`[ListingsSync] Reconcile failed store=${code}:`, e)
      }
    } else {
      console.warn(`[ListingsSync] store=${code} ${reconciliation.reason}`)
    }

    const syncHint = buildSyncHint({
      tradingRows,
      inserted,
      updated,
      errors,
      globalSkuBlocked,
      accountConnected: accountStatus.connected ?? false,
      accountExpired:   accountStatus.expired ?? false,
    })

    console.log(
      `[ListingsSync] storeCode=${code} store_id=${store.id} ebay_user_id=${accountStatus.ebayUserId ?? "none"} trading=${tradingRows} inserted=${inserted} updated=${updated} skipped=${skipped} errors=${errors} reconciled=${reconciled} dbConcurrency=${CATALOG_DB_WRITE_CONCURRENCY}`
    )

    await recordCatalogSyncComplete(store.id)
    await writeSyncReceipt({ workspaceId, store, startedAt, status: "completed", receipt: paginationReceipt,
      reconciliationEligible: reconciliation.eligible, reconciliationRan: reconciliation.eligible,
      reconciliationEndedCount: reconciled, errorMessage: reconciliation.reason })

    return {
      ok:          true,
      storeCode:     code,
      storeId:       store.id,
      tradingRows,
      inserted,
      updated,
      skipped,
      errors,
      reconciled,
      syncHint,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const receipt = e instanceof EbayCatalogPaginationIncompleteError ? e.receipt : paginationReceipt
    await writeSyncReceipt({ workspaceId, store, startedAt, status: receipt ? "incomplete" : "failed", receipt,
      reconciliationEligible: false, reconciliationRan: false, reconciliationEndedCount: 0, errorMessage: msg }).catch(() => undefined)
    await recordCatalogSyncFailed(store.id, msg).catch(() => undefined)
    throw e
  } finally {
    activeCatalogSyncByStoreId.delete(store.id)
  }
}
