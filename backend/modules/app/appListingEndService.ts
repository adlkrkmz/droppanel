// ----------------------------------------------------------------
// appListingEndService.ts — user-scoped single + shared bulk end (Phase 5J / 5R)
// eBay write via same API paths as admin endListings; on eBay success the catalog row is hard-deleted.
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { insertAuditLog } from "../auth/authRepository"
import { EbayApiClient } from "../ebay/ebayApiClient"
import {
  isManualEndMutationEnabled,
  manualEndMutationDisabledMessage,
} from "../ebay/manualEndMutationSource"
import { getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import { resolveListingAsin } from "../monitor/monitorService"
import { afterListingMonitoringStopped } from "../stockGuard/stockGuardV2LifecycleHooks"
import type { OwnedStore } from "./appOwnership"
import type { AppBulkEndListingItemResult, AppEndListingResponse } from "./appTypes"
import { AppHttpError } from "./appTypes"

export type EndListingRow = {
  id:            number
  storeId:       number
  ebayItemId:    string | null
  ebayOfferId:   string | null
  asin:          string | null
  currentStatus: string | null
}

function mapEndListingRow(row: {
  id: number | string
  store_id: number | string
  ebay_item_id: string | null
  ebay_offer_id: string | null
  registry_asin: string | null
  source_url: string | null
  internal_sku: string
  current_status: string | null
}): EndListingRow {
  return {
    // pg returns bigint as string — Map lookups use numeric catalogStateIds from the request.
    id:            Number(row.id),
    storeId:       Number(row.store_id),
    ebayItemId:    row.ebay_item_id?.trim() || null,
    ebayOfferId:   row.ebay_offer_id?.trim() || null,
    asin: resolveListingAsin({
      registryAsin: row.registry_asin,
      sourceUrl:    row.source_url,
      internalSku:  row.internal_sku?.trim() ?? "",
    }),
    currentStatus: row.current_status?.trim() || null,
  }
}

async function loadListingForEnd(
  workspaceId:    string,
  storeCode:      string,
  catalogStateId: number
): Promise<EndListingRow | null> {
  const res = await query<{
    id: number
    store_id: number
    ebay_item_id: string | null
    ebay_offer_id: string | null
    registry_asin: string | null
    source_url: string | null
    internal_sku: string
    current_status: string | null
  }>(
    `SELECT scs.id,
            scs.store_id,
            scs.ebay_item_id,
            scs.ebay_offer_id,
            ar.asin AS registry_asin,
            scs.source_url,
            scs.internal_sku,
            scs.current_status::text AS current_status
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id AND s.workspace_id = scs.workspace_id
     LEFT JOIN asin_registry ar ON ar.id = scs.asin_registry_id
     WHERE scs.workspace_id = $1::uuid
       AND s.store_code = $2
       AND scs.id = $3::bigint
       AND s.status = 'active'
       AND scs.panel_hidden_at IS NULL
     LIMIT 1`,
    [workspaceId, storeCode.trim(), catalogStateId]
  )

  const row = res.rows[0]
  if (!row) return null
  return mapEndListingRow(row)
}

export async function loadOwnedListingsForEndByIds(
  workspaceId:     string,
  storeId:         number,
  storeCode:       string,
  catalogStateIds: number[]
): Promise<Map<number, EndListingRow>> {
  if (catalogStateIds.length === 0) return new Map()

  const res = await query<{
    id: number
    store_id: number
    ebay_item_id: string | null
    ebay_offer_id: string | null
    registry_asin: string | null
    source_url: string | null
    internal_sku: string
    current_status: string | null
  }>(
    `SELECT scs.id,
            scs.store_id,
            scs.ebay_item_id,
            scs.ebay_offer_id,
            ar.asin AS registry_asin,
            scs.source_url,
            scs.internal_sku,
            scs.current_status::text AS current_status
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id AND s.workspace_id = scs.workspace_id
     LEFT JOIN asin_registry ar ON ar.id = scs.asin_registry_id
     WHERE scs.workspace_id = $1::uuid
       AND scs.store_id = $2::bigint
       AND s.store_code = $3
       AND s.status = 'active'
       AND scs.panel_hidden_at IS NULL
       AND scs.id = ANY($4::bigint[])`,
    [workspaceId, storeId, storeCode.trim(), catalogStateIds]
  )

  const map = new Map<number, EndListingRow>()
  for (const row of res.rows) {
    const mapped = mapEndListingRow(row)
    if (!Number.isFinite(mapped.id) || mapped.id <= 0) continue
    map.set(mapped.id, mapped)
  }
  return map
}

export async function assertEbayAccountConnected(
  workspaceId: string,
  storeCode:   string
): Promise<void> {
  try {
    await getValidAccessToken(workspaceId, storeCode, false)
  } catch {
    throw new AppHttpError(400, "eBay account is not connected for this store")
  }
}

async function endListingOnEbay(input: {
  workspaceId: string
  storeCode:   string
  ebayItemId:  string
  ebayOfferId: string | null
}): Promise<void> {
  if (!isManualEndMutationEnabled()) {
    throw new AppHttpError(503, manualEndMutationDisabledMessage())
  }

  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
  const token = await getValidAccessToken(input.workspaceId, input.storeCode, false)
  const client = new EbayApiClient({
    oauthToken:     token,
    sandbox,
    simulationMode: false,
  })

  const offerId = input.ebayOfferId?.trim()
  const endRequest = offerId
    ? client.withdrawOffer(offerId)
    : client.endFixedPriceItem(input.ebayItemId)

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      endRequest,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new AppHttpError(504, "eBay End result is unknown; verify eBay before retrying.")),
          30_000
        )
      }),
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

/** Hard-delete one catalog row after eBay end (or legacy ended cleanup). Preserves order history. */
export async function hardDeleteCatalogListing(
  workspaceId:    string,
  storeId:        number,
  catalogStateId: number
): Promise<void> {
  // Detach historical order matches — do not delete order rows.
  await query(
    `UPDATE ebay_order_items
     SET matched_catalog_state_id = NULL
     WHERE matched_catalog_state_id = $1::bigint`,
    [catalogStateId]
  )
  await query(
    `UPDATE sold_item_restock_events
     SET catalog_state_id = NULL
     WHERE catalog_state_id = $1::bigint`,
    [catalogStateId]
  )
  await query(
    `UPDATE workspace_activity_events
     SET catalog_state_id = NULL
     WHERE workspace_id = $1::uuid
       AND catalog_state_id = $2::bigint`,
    [workspaceId, catalogStateId]
  )
  // Panel stock-alert rows are listing-bound metadata — remove with the listing.
  await query(
    `DELETE FROM stock_review_items
     WHERE workspace_id = $1::uuid
       AND catalog_state_id = $2::bigint`,
    [workspaceId, catalogStateId]
  )

  // CASCADE also clears global_asin_consumers + amazon_price_verification_tasks.
  const result = await query(
    `DELETE FROM store_catalog_state
     WHERE workspace_id = $1::uuid
       AND store_id = $2::bigint
       AND id = $3::bigint`,
    [workspaceId, storeId, catalogStateId]
  )
  if ((result.rowCount ?? 0) === 0) {
    throw new AppHttpError(404, "Listing not found")
  }
}

async function writeEndListingAudit(input: {
  actorUserId:    string
  success:        boolean
  workspaceId:    string
  store:          OwnedStore
  catalogStateId: number
  ebayItemId?:    string | null
  asin?:          string | null
  previousStatus?: string | null
  batchId?:       string
  status?:        number
  reason?:        string
}): Promise<void> {
  try {
    const batchMeta = input.batchId ? { batchId: input.batchId } : {}

    await insertAuditLog({
      actorUserId: input.actorUserId,
      action: input.success
        ? "app.listings.end"
        : "app.listings.end.failed",
      targetType: "catalog_state",
      targetId:   String(input.catalogStateId),
      metadata: input.success
        ? {
            workspaceId:    input.workspaceId,
            storeCode:      input.store.storeCode,
            catalogStateId: input.catalogStateId,
            ebayItemId:     input.ebayItemId ?? null,
            asin:           input.asin ?? null,
            previousStatus: input.previousStatus ?? null,
            newStatus:      "removed",
            actorUserId:    input.actorUserId,
            ...batchMeta,
          }
        : {
            workspaceId:    input.workspaceId,
            storeCode:      input.store.storeCode,
            catalogStateId: input.catalogStateId,
            ebayItemId:     input.ebayItemId ?? null,
            status:         input.status ?? 502,
            reason:         input.reason?.slice(0, 200) ?? "End listing failed",
            ...batchMeta,
          },
    })
  } catch (e) {
    console.warn(
      "[App][listings-end] audit log failed:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

export function parseEndListingBody(body: Record<string, unknown>): void {
  if (body.confirm !== true) {
    throw new AppHttpError(400, "confirm must be true")
  }
}

export async function endOwnedListingItem(input: {
  workspaceId: string
  actorUserId: string
  store:       OwnedStore
  listing:     EndListingRow
  batchId?:    string
}): Promise<AppBulkEndListingItemResult> {
  const catalogStateId = input.listing.id
  const previousStatus = input.listing.currentStatus

  // Already ended in panel / no eBay id → hard-delete locally (no eBay write).
  if (previousStatus?.toLowerCase() === "ended" || !input.listing.ebayItemId) {
    await afterListingMonitoringStopped({
      workspaceId: input.workspaceId,
      catalogStateIds: [catalogStateId],
      ebayItemIds: input.listing.ebayItemId ? [input.listing.ebayItemId] : undefined,
    })
    try {
      await hardDeleteCatalogListing(input.workspaceId, input.store.id, catalogStateId)
    } catch (e) {
      const httpErr =
        e instanceof AppHttpError ? e : new AppHttpError(502, "Could not remove listing")
      await writeEndListingAudit({
        actorUserId:    input.actorUserId,
        success:        false,
        workspaceId:    input.workspaceId,
        store:          input.store,
        catalogStateId,
        ebayItemId:     input.listing.ebayItemId,
        status:         httpErr.status,
        reason:         httpErr.message,
        batchId:        input.batchId,
      })
      return {
        catalogStateId,
        ok:    false,
        error: httpErr.message.slice(0, 120),
      }
    }

    await writeEndListingAudit({
      actorUserId:    input.actorUserId,
      success:        true,
      workspaceId:    input.workspaceId,
      store:          input.store,
      catalogStateId,
      ebayItemId:     input.listing.ebayItemId,
      asin:           input.listing.asin,
      previousStatus,
      batchId:        input.batchId,
    })

    return {
      catalogStateId,
      ok:         true,
      ebayItemId: input.listing.ebayItemId ?? undefined,
      status:     "removed",
      message:    input.listing.ebayItemId
        ? "Listing removed from ListJetGo."
        : "Listing removed locally (no eBay item ID).",
    }
  }

  try {
    await endListingOnEbay({
      workspaceId: input.workspaceId,
      storeCode:   input.store.storeCode,
      ebayItemId:  input.listing.ebayItemId,
      ebayOfferId: input.listing.ebayOfferId,
    })
  } catch (e) {
    const httpErr =
      e instanceof AppHttpError
        ? e
        : new AppHttpError(502, "Could not end listing")

    await writeEndListingAudit({
      actorUserId:    input.actorUserId,
      success:        false,
      workspaceId:    input.workspaceId,
      store:          input.store,
      catalogStateId,
      ebayItemId:     input.listing.ebayItemId,
      status:         httpErr.status,
      reason:         httpErr.message,
      batchId:        input.batchId,
    })

    // eBay failed → keep DB row.
    return {
      catalogStateId,
      ok:    false,
      error: httpErr.message.slice(0, 120),
    }
  }

  await afterListingMonitoringStopped({
    workspaceId: input.workspaceId,
    catalogStateIds: [catalogStateId],
    ebayItemIds: [input.listing.ebayItemId],
  })

  try {
    await hardDeleteCatalogListing(input.workspaceId, input.store.id, catalogStateId)
  } catch (e) {
    const httpErr =
      e instanceof AppHttpError ? e : new AppHttpError(502, "Could not remove listing")
    await writeEndListingAudit({
      actorUserId:    input.actorUserId,
      success:        false,
      workspaceId:    input.workspaceId,
      store:          input.store,
      catalogStateId,
      ebayItemId:     input.listing.ebayItemId,
      status:         httpErr.status,
      reason:         `eBay ended but DB delete failed: ${httpErr.message}`,
      batchId:        input.batchId,
    })
    return {
      catalogStateId,
      ok:    false,
      error: "Listing ended on eBay but could not be removed from ListJetGo.".slice(0, 120),
    }
  }

  await writeEndListingAudit({
    actorUserId:    input.actorUserId,
    success:        true,
    workspaceId:    input.workspaceId,
    store:          input.store,
    catalogStateId,
    ebayItemId:     input.listing.ebayItemId,
    asin:           input.listing.asin,
    previousStatus,
    batchId:        input.batchId,
  })

  return {
    catalogStateId,
    ok:         true,
    ebayItemId: input.listing.ebayItemId,
    status:     "removed",
    message:    "Listing ended on eBay and removed from ListJetGo.",
  }
}

export async function appEndListing(input: {
  workspaceId:    string
  actorUserId:    string
  store:          OwnedStore
  catalogStateId: number
}): Promise<AppEndListingResponse> {
  const listing = await loadListingForEnd(
    input.workspaceId,
    input.store.storeCode,
    input.catalogStateId
  )
  if (!listing) {
    throw new AppHttpError(404, "Listing not found")
  }

  await assertEbayAccountConnected(input.workspaceId, input.store.storeCode)

  const result = await endOwnedListingItem({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    store:       input.store,
    listing,
  })

  if (!result.ok) {
    if (result.error === "Listing is missing eBay item ID.") {
      throw new AppHttpError(400, result.error)
    }
    throw new AppHttpError(502, result.error ?? "Could not end listing")
  }

  return {
    ok:             true,
    storeCode:      input.store.storeCode,
    catalogStateId: listing.id,
    ebayItemId:     result.ebayItemId,
    status:         "removed",
    message:        result.message ?? "Listing ended on eBay and removed from ListJetGo.",
  }
}
