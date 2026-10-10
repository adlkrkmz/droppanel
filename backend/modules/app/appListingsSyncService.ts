// ----------------------------------------------------------------
// appListingsSyncService.ts — user-scoped eBay listing sync (Phase 3I-B)
// Background-safe: queues canonical catalog sync by exact store_id.
// ----------------------------------------------------------------

import { insertAuditLog } from "../auth/authRepository"
import { scheduleCatalogSyncImmediateByStoreId } from "../storeSync/storeSyncScheduleService"
import type { OwnedStore } from "./appOwnership"
import { AppHttpError } from "./appTypes"

export type AppListingsSyncAcceptedResponse = {
  ok:         true
  accepted:   true
  storeId:    number
  storeCode:  string
  syncStatus: string | null
  queued:     boolean
  message:    string
}

function mapSyncError(e: unknown): AppHttpError {
  const msg = e instanceof Error ? e.message : String(e)

  if (/no eBay account connected/i.test(msg)) {
    return new AppHttpError(400, "eBay account is not connected for this store")
  }
  if (/token expired|401|403/i.test(msg)) {
    return new AppHttpError(400, "eBay account is not connected for this store")
  }
  if (/active store not found|store not found/i.test(msg)) {
    return new AppHttpError(404, "Store not found")
  }
  if (/storeId is required|storeCode is required/i.test(msg)) {
    return new AppHttpError(400, msg)
  }

  return new AppHttpError(500, msg.length > 160 ? "Listing sync failed" : msg)
}

/**
 * Queue catalog sync (listings + Sold) for an owned store. Returns immediately.
 * Progress: GET /app/import/status (syncStatus pending|catalog_running|ok|error).
 */
export async function appSyncListings(input: {
  workspaceId:   string
  actorUserId:   string
  store:         OwnedStore
}): Promise<AppListingsSyncAcceptedResponse> {
  try {
    const result = await scheduleCatalogSyncImmediateByStoreId(
      input.workspaceId,
      input.store.id
    )

    await insertAuditLog({
      actorUserId: input.actorUserId,
      action:      "app.listings.sync.queued",
      targetType:  "store",
      targetId:    String(input.store.id),
      metadata:    {
        storeId:    input.store.id,
        storeCode:  input.store.storeCode,
        queued:     result.queued,
        syncStatus: result.syncStatus,
      },
    })

    return {
      ok:         true,
      accepted:   true,
      storeId:    input.store.id,
      storeCode:  input.store.storeCode,
      syncStatus: result.syncStatus,
      queued:     result.queued,
      message:    result.queued
        ? "Catalog sync started. Listings and Sold will refresh shortly."
        : "Catalog sync already in progress for this store.",
    }
  } catch (e) {
    const httpErr = mapSyncError(e)

    await insertAuditLog({
      actorUserId: input.actorUserId,
      action:      "app.listings.sync.failed",
      targetType:  "store",
      targetId:    String(input.store.id),
      metadata:    {
        storeId: input.store.id,
        status:  httpErr.status,
      },
    }).catch(() => {})

    throw httpErr
  }
}
