// ----------------------------------------------------------------
// appListingBulkEndService.ts — user-scoped bulk eBay end (Phase 5R)
// ----------------------------------------------------------------

import { randomUUID } from "crypto"
import { insertAuditLog } from "../auth/authRepository"
import type { OwnedStore } from "./appOwnership"
import {
  assertEbayAccountConnected,
  endOwnedListingItem,
  loadOwnedListingsForEndByIds,
  parseEndListingBody,
  type EndListingRow,
} from "./appListingEndService"
import type { AppBulkEndListingItemResult, AppBulkEndListingsResponse } from "./appTypes"
import { AppHttpError } from "./appTypes"

/** No user-facing max — selected listings are processed in full (chunked internally). */
const BULK_END_DB_LOAD_CHUNK = 200
const BULK_END_CONCURRENCY = 3

async function writeBulkEndBatchAudit(input: {
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
        ? "app.bulk.listings.end"
        : "app.bulk.listings.end.failed",
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
            requested:   input.requested,
            succeeded:   input.succeeded,
            failed:      input.failed,
            status:      input.status ?? 400,
            reason:      input.reason?.slice(0, 200) ?? "Bulk end listing failed",
          },
    })
  } catch (e) {
    console.warn(
      "[App][listings-bulk-end] batch audit log failed:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

export function parseBulkEndListingBody(body: Record<string, unknown>): void {
  parseEndListingBody(body)

  if (body.quantity !== undefined) {
    throw new AppHttpError(400, "Quantity is not accepted for this action.")
  }
  if (body.price !== undefined) {
    throw new AppHttpError(400, "Price is not accepted for this action.")
  }
}

export function parseBulkEndCatalogStateIdsBody(body: Record<string, unknown>): number[] {
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

  return ids
}

export async function appBulkEndListings(input: {
  workspaceId:     string
  actorUserId:     string
  store:           OwnedStore
  catalogStateIds: number[]
}): Promise<AppBulkEndListingsResponse> {
  await assertEbayAccountConnected(input.workspaceId, input.store.storeCode)

  const batchId = randomUUID()
  const listingMap = new Map<number, EndListingRow>()

  for (let i = 0; i < input.catalogStateIds.length; i += BULK_END_DB_LOAD_CHUNK) {
    const chunk = input.catalogStateIds.slice(i, i + BULK_END_DB_LOAD_CHUNK)
    const partial = await loadOwnedListingsForEndByIds(
      input.workspaceId,
      input.store.id,
      input.store.storeCode,
      chunk
    )
    for (const [id, row] of partial) {
      listingMap.set(id, row)
    }
  }

  const results: AppBulkEndListingItemResult[] = []

  for (let i = 0; i < input.catalogStateIds.length; i += BULK_END_CONCURRENCY) {
    const batchIds = input.catalogStateIds.slice(i, i + BULK_END_CONCURRENCY)
    const batchResults = await Promise.all(batchIds.map(async catalogStateId => {
      const listing = listingMap.get(catalogStateId)
      if (!listing) {
        return {
          catalogStateId,
          ok:    false,
          error: "Listing not found.",
        }
      }

      try {
        return await endOwnedListingItem({
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          store:       input.store,
          listing,
          batchId,
        })
      } catch {
        return {
          catalogStateId,
          ok:    false,
          error: "End result is unknown; verify eBay before retrying.",
        }
      }
    }))
    results.push(...batchResults)
  }

  const succeeded = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length

  await writeBulkEndBatchAudit({
    actorUserId: input.actorUserId,
    success:     failed === 0,
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
