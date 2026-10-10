// ----------------------------------------------------------------
// appListingUpdateSourceAsinService.ts — user-scoped source ASIN update (Phase 5I)
// Reuses updateListingSourceAsin (Keepa check + DB update). No eBay writes.
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { insertAuditLog } from "../auth/authRepository"
import {
  normalizeAsinInput,
  updateListingSourceAsin,
  validateNewAsin,
} from "../listings/listingsUpdateSourceAsinService"
import { resolveListingAsin } from "../monitor/monitorService"
import type { OwnedStore } from "./appOwnership"
import type { AppUpdateSourceAsinResponse } from "./appTypes"
import { AppHttpError } from "./appTypes"

type ListingAsinRow = {
  id: number
  ebayItemId: string | null
  internalSku: string
  sourceUrl: string | null
  registryAsin: string | null
}

async function loadListingAsinRow(
  workspaceId:    string,
  storeId:        number,
  catalogStateId: number
): Promise<ListingAsinRow | null> {
  const res = await query<{
    id: number
    ebay_item_id: string | null
    internal_sku: string
    source_url: string | null
    registry_asin: string | null
  }>(
    `SELECT scs.id,
            scs.ebay_item_id,
            scs.internal_sku,
            scs.source_url,
            ar.asin AS registry_asin
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id AND s.workspace_id = scs.workspace_id
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND scs.store_id = $2::bigint
       AND scs.id = $3::bigint
       AND scs.panel_hidden_at IS NULL
       AND s.status = 'active'
     LIMIT 1`,
    [workspaceId, storeId, catalogStateId]
  )

  const row = res.rows[0]
  if (!row) return null

  return {
    id:           row.id,
    ebayItemId:   row.ebay_item_id?.trim() || null,
    internalSku:  row.internal_sku?.trim() ?? "",
    sourceUrl:    row.source_url?.trim() || null,
    registryAsin: row.registry_asin?.trim() || null,
  }
}

async function writeSourceAsinAudit(input: {
  actorUserId:    string
  success:        boolean
  workspaceId:    string
  store:          OwnedStore
  catalogStateId: number
  ebayItemId?:    string | null
  asin?:          string
  previousAsin?:  string | null
  keepaChecked?:  boolean
  status?:        number
  reason?:        string
}): Promise<void> {
  try {
    await insertAuditLog({
      actorUserId: input.actorUserId,
      action: input.success
        ? "app.listings.source_asin.update"
        : "app.listings.source_asin.update.failed",
      targetType: "catalog_state",
      targetId:   String(input.catalogStateId),
      metadata: input.success
        ? {
            workspaceId:    input.workspaceId,
            storeCode:      input.store.storeCode,
            catalogStateId: input.catalogStateId,
            ebayItemId:     input.ebayItemId ?? null,
            previousAsin:   input.previousAsin ?? null,
            newAsin:        input.asin,
            actorUserId:    input.actorUserId,
            keepaChecked:   input.keepaChecked === true,
            conflictStatus: "none",
          }
        : {
            storeCode:      input.store.storeCode,
            catalogStateId: input.catalogStateId,
            asin:           input.asin?.slice(0, 10),
            status:         input.status ?? 400,
            reason:         input.reason?.slice(0, 200) ?? "Source ASIN update failed",
          },
    })
  } catch (e) {
    console.warn(
      "[App][listings-source-asin] audit log failed:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

function mapUpdateError(e: unknown): AppHttpError {
  const msg = e instanceof Error ? e.message : String(e)
  if (/Active store not found|Listing not found/i.test(msg)) {
    return new AppHttpError(404, "Listing not found")
  }
  if (
    /ASIN is required|ASIN must be 10 characters|storeCode is required|catalogStateId is required/i.test(
      msg
    )
  ) {
    return new AppHttpError(400, msg.length > 160 ? "Invalid ASIN" : msg)
  }
  if (/New ASIN must be different/i.test(msg)) {
    return new AppHttpError(400, msg.length > 160 ? "ASIN could not be updated" : msg)
  }
  return new AppHttpError(502, "Could not update source ASIN")
}

export function parseAppSourceAsinBody(body: Record<string, unknown>): string {
  const raw = String(body.asin ?? "").trim()
  if (!raw) throw new AppHttpError(400, "asin is required")
  const asin = normalizeAsinInput(raw)
  try {
    validateNewAsin(asin)
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid ASIN"
    throw new AppHttpError(400, msg)
  }
  return asin
}

export async function appUpdateListingSourceAsin(input: {
  workspaceId:    string
  actorUserId:    string
  store:          OwnedStore
  catalogStateId: number
  asin:           string
}): Promise<AppUpdateSourceAsinResponse> {
  const listing = await loadListingAsinRow(
    input.workspaceId,
    input.store.id,
    input.catalogStateId
  )
  if (!listing) {
    throw new AppHttpError(404, "Listing not found")
  }

  const previousAsin = resolveListingAsin({
    registryAsin: listing.registryAsin,
    sourceUrl:    listing.sourceUrl,
    internalSku:  listing.internalSku,
  })

  if (previousAsin === input.asin) {
    return {
      ok:             true,
      storeCode:      input.store.storeCode,
      catalogStateId: listing.id,
      asin:           input.asin,
      previousAsin,
      message:        "Source ASIN is already linked.",
    }
  }

  try {
    await updateListingSourceAsin({
      workspaceId:    input.workspaceId,
      storeCode:      input.store.storeCode,
      catalogStateId: listing.id,
      newAsinRaw:     input.asin,
    })
  } catch (e) {
    const httpErr = mapUpdateError(e)
    await writeSourceAsinAudit({
      actorUserId:    input.actorUserId,
      success:        false,
      workspaceId:    input.workspaceId,
      store:          input.store,
      catalogStateId: listing.id,
      ebayItemId:     listing.ebayItemId,
      asin:           input.asin,
      status:         httpErr.status,
      reason:         httpErr.message,
    })
    throw httpErr
  }

  await writeSourceAsinAudit({
    actorUserId:    input.actorUserId,
    success:        true,
    workspaceId:    input.workspaceId,
    store:          input.store,
    catalogStateId: listing.id,
    ebayItemId:     listing.ebayItemId,
    asin:           input.asin,
    previousAsin,
    keepaChecked:   false,
  })

  return {
    ok:             true,
    storeCode:      input.store.storeCode,
    catalogStateId: listing.id,
    asin:           input.asin,
    previousAsin,
    message:        "Source ASIN updated.",
  }
}
