// ----------------------------------------------------------------
// appListingBulkStockGuardService.ts — user-scoped bulk Stock Guard toggle (Phase 5N)
// ----------------------------------------------------------------

import { randomUUID } from "crypto"
import { insertAuditLog } from "../auth/authRepository"
import type { OwnedStore } from "./appOwnership"
import {
  loadOwnedListingsForStockGuardByIds,
  updateOwnedListingStockGuardItem,
  type AppListingStockGuardItemResult,
} from "./appListingStockGuardService"
import type { AppBulkListingStockGuardResponse } from "./appTypes"
import { AppHttpError } from "./appTypes"

export const BULK_STOCK_GUARD_MAX_LISTINGS = 50

async function writeBulkStockGuardBatchAudit(input: {
  actorUserId: string
  success:     boolean
  workspaceId: string
  storeCode:   string
  batchId:     string
  requested:   number
  succeeded:   number
  failed:      number
  enabled:     boolean
  status?:     number
  reason?:     string
}): Promise<void> {
  try {
    await insertAuditLog({
      actorUserId: input.actorUserId,
      action: input.success
        ? "app.bulk.listings.stock_guard.update"
        : "app.bulk.listings.stock_guard.update.failed",
      targetType: "catalog_state_batch",
      targetId:   input.batchId,
      metadata: input.success
        ? {
            workspaceId: input.workspaceId,
            storeCode:     input.storeCode,
            batchId:       input.batchId,
            requested:     input.requested,
            succeeded:     input.succeeded,
            failed:        input.failed,
            enabled:       input.enabled,
            actorUserId:   input.actorUserId,
          }
        : {
            workspaceId: input.workspaceId,
            storeCode:   input.storeCode,
            batchId:     input.batchId,
            status:      input.status ?? 400,
            reason:      input.reason?.slice(0, 200) ?? "Bulk Stock Guard update failed",
          },
    })
  } catch (e) {
    console.warn(
      "[App][listings-bulk-stock-guard] batch audit log failed:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

export function parseBulkCatalogStateIdsBody(body: Record<string, unknown>): number[] {
  const raw = body.catalogStateIds
  if (!Array.isArray(raw)) {
    throw new AppHttpError(400, "catalogStateIds must be an array")
  }
  if (raw.length === 0) {
    throw new AppHttpError(400, "catalogStateIds must not be empty")
  }

  const ids: number[] = []
  const seen = new Set<number>()

  for (const item of raw) {
    const id = Number(item)
    if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
      throw new AppHttpError(400, "catalogStateIds must contain positive integers")
    }
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  if (ids.length === 0) {
    throw new AppHttpError(400, "catalogStateIds must not be empty")
  }
  if (ids.length > BULK_STOCK_GUARD_MAX_LISTINGS) {
    throw new AppHttpError(400, `catalogStateIds must not exceed ${BULK_STOCK_GUARD_MAX_LISTINGS}`)
  }

  return ids
}

export async function appBulkUpdateListingStockGuard(input: {
  workspaceId:     string
  actorUserId:     string
  store:           OwnedStore
  catalogStateIds: number[]
  enabled:         boolean
}): Promise<AppBulkListingStockGuardResponse> {
  const batchId = randomUUID()
  const listingMap = await loadOwnedListingsForStockGuardByIds(
    input.workspaceId,
    input.store.id,
    input.store.storeCode,
    input.catalogStateIds
  )

  const results: AppListingStockGuardItemResult[] = []

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

    const itemResult = await updateOwnedListingStockGuardItem({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      store:       input.store,
      listing,
      enabled:     input.enabled,
      batchId,
    })
    results.push(itemResult)
  }

  const succeeded = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length

  await writeBulkStockGuardBatchAudit({
    actorUserId: input.actorUserId,
    success:     true,
    workspaceId: input.workspaceId,
    storeCode:   input.store.storeCode,
    batchId,
    requested:   input.catalogStateIds.length,
    succeeded,
    failed,
    enabled:     input.enabled,
  })

  return {
    ok:                true,
    storeCode:         input.store.storeCode,
    batchId,
    requested:         input.catalogStateIds.length,
    succeeded,
    failed,
    stockGuardEnabled: input.enabled,
    results,
  }
}
