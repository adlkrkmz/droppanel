// ----------------------------------------------------------------
// appListingBulkHideService.ts — user-scoped bulk panel hide (Phase 5O)
// ----------------------------------------------------------------

import { randomUUID } from "crypto"
import { insertAuditLog } from "../auth/authRepository"
import type { OwnedStore } from "./appOwnership"
import {
  hideOwnedListingItem,
  loadOwnedListingsForHideByIds,
  type AppListingHideItemResult,
} from "./appListingHideService"
import { parseBulkCatalogStateIdsBody } from "./appListingBulkStockGuardService"
import type { AppBulkHideListingsResponse } from "./appTypes"

export { parseBulkCatalogStateIdsBody }

async function writeBulkHideBatchAudit(input: {
  actorUserId: string
  success:     boolean
  workspaceId: string
  storeCode:   string
  batchId:     string
  requested:   number
  succeeded:   number
  failed:      number
  status?:     number
  reason?:     string
}): Promise<void> {
  try {
    await insertAuditLog({
      actorUserId: input.actorUserId,
      action: input.success
        ? "app.bulk.listings.hide"
        : "app.bulk.listings.hide.failed",
      targetType: "catalog_state_batch",
      targetId:   input.batchId,
      metadata: input.success
        ? {
            workspaceId: input.workspaceId,
            storeCode:   input.storeCode,
            batchId:     input.batchId,
            requested:   input.requested,
            succeeded:   input.succeeded,
            failed:      input.failed,
            actorUserId: input.actorUserId,
          }
        : {
            workspaceId: input.workspaceId,
            storeCode:   input.storeCode,
            batchId:     input.batchId,
            status:      input.status ?? 400,
            reason:      input.reason?.slice(0, 200) ?? "Bulk hide failed",
          },
    })
  } catch (e) {
    console.warn(
      "[App][listings-bulk-hide] batch audit log failed:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

export async function appBulkHideListings(input: {
  workspaceId:     string
  actorUserId:     string
  store:           OwnedStore
  catalogStateIds: number[]
}): Promise<AppBulkHideListingsResponse> {
  const batchId = randomUUID()
  const listingMap = await loadOwnedListingsForHideByIds(
    input.workspaceId,
    input.store.id,
    input.store.storeCode,
    input.catalogStateIds
  )

  const results: AppListingHideItemResult[] = []

  for (const catalogStateId of input.catalogStateIds) {
    const listing = listingMap.get(catalogStateId)
    if (!listing) {
      results.push({
        catalogStateId,
        ok:    false,
        error: "Listing not found.",
      })
      continue
    }

    const itemResult = await hideOwnedListingItem({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      store:       input.store,
      listing,
      batchId,
    })
    results.push(itemResult)
  }

  const succeeded = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length

  await writeBulkHideBatchAudit({
    actorUserId: input.actorUserId,
    success:     true,
    workspaceId: input.workspaceId,
    storeCode:   input.store.storeCode,
    batchId,
    requested:   input.catalogStateIds.length,
    succeeded,
    failed,
  })

  return {
    ok:        true,
    storeCode: input.store.storeCode,
    batchId,
    requested: input.catalogStateIds.length,
    succeeded,
    failed,
    results,
  }
}
