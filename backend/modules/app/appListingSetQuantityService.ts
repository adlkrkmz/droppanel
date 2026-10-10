// ----------------------------------------------------------------
// appListingSetQuantityService.ts — user-scoped Set Qty 0 / Set Qty 1 (SYNC-008)
// Quantity-only eBay update via shared bulk_update_price_quantity path
// (no description/title/image — full inventory-item endpoint is NOT used).
// ----------------------------------------------------------------

import { randomUUID } from "crypto"
import { query } from "../../db/client"
import { insertAuditLog } from "../auth/authRepository"
import { getValidAccessTokenByStoreId } from "../ebayOAuth/ebayOAuthService"
import {
  setListingQuantityOnEbay,
  QuantityOutcomeUncertainError,
} from "../stockAlerts/stockAlertsEbayZeroService"
import {
  isQuantityMutationSourceEnabled,
  quantityMutationDisabledMessage,
} from "../ebay/quantityMutationSource"
import { afterManualQuantityChanged } from "../stockGuard/stockGuardV2LifecycleHooks"
import type { OwnedStore } from "./appOwnership"
import type {
  AppSetListingQuantityResponse,
  AppBulkSetListingQuantityResponse,
  AppBulkSetListingQuantityItemResult,
} from "./appTypes"
import { AppHttpError } from "./appTypes"

export const ALLOWED_SET_QUANTITIES = new Set([0, 1])
export const BULK_SET_QUANTITY_MAX = 50
export const BULK_SET_QUANTITY_CONCURRENCY = 3

type QuantityOutcome = "succeeded" | "failed" | "uncertain"

type SetQuantityCatalog = {
  id:            number
  storeId:       number
  internalSku:   string | null
  ebayItemId:    string | null
  ebayOfferId:   string | null
  ebayQuantity:  number
  currentStatus: string | null
}

function mapSetQuantityRow(row: {
  id: number | string
  store_id: number | string
  internal_sku: string | null
  ebay_item_id: string | null
  ebay_offer_id: string | null
  ebay_quantity: number | null
  current_status: string | null
}): SetQuantityCatalog {
  return {
    // pg returns bigint as string — Map lookups use numeric catalogStateIds from the request.
    id:            Number(row.id),
    storeId:       Number(row.store_id),
    internalSku:   row.internal_sku?.trim() || null,
    ebayItemId:    row.ebay_item_id?.trim() || null,
    ebayOfferId:   row.ebay_offer_id?.trim() || null,
    ebayQuantity:  row.ebay_quantity ?? 0,
    currentStatus: row.current_status?.trim() || null,
  }
}

async function loadSetQuantityCatalog(
  workspaceId:    string,
  storeId:        number,
  catalogStateId: number
): Promise<SetQuantityCatalog | null> {
  const res = await query<{
    id: number
    store_id: number
    internal_sku: string | null
    ebay_item_id: string | null
    ebay_offer_id: string | null
    ebay_quantity: number | null
    current_status: string | null
  }>(
    `SELECT scs.id,
            scs.store_id,
            scs.internal_sku,
            scs.ebay_item_id,
            scs.ebay_offer_id,
            scs.ebay_quantity,
            scs.current_status::text AS current_status
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id AND s.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND scs.store_id = $2::bigint
       AND scs.id = $3::bigint
       AND s.status = 'active'
       AND scs.panel_hidden_at IS NULL
     LIMIT 1`,
    [workspaceId, storeId, catalogStateId]
  )

  const row = res.rows[0]
  if (!row) return null
  return mapSetQuantityRow(row)
}

async function loadSetQuantityCatalogByIds(
  workspaceId:     string,
  storeId:         number,
  storeCode:       string,
  catalogStateIds: number[]
): Promise<Map<number, SetQuantityCatalog>> {
  if (catalogStateIds.length === 0) return new Map()

  const res = await query<{
    id: number
    store_id: number
    internal_sku: string | null
    ebay_item_id: string | null
    ebay_offer_id: string | null
    ebay_quantity: number | null
    current_status: string | null
  }>(
    `SELECT scs.id,
            scs.store_id,
            scs.internal_sku,
            scs.ebay_item_id,
            scs.ebay_offer_id,
            scs.ebay_quantity,
            scs.current_status::text AS current_status
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id AND s.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND scs.store_id = $2::bigint
       AND s.store_code = $3
       AND s.status = 'active'
       AND scs.panel_hidden_at IS NULL
       AND scs.id = ANY($4::bigint[])`,
    [workspaceId, storeId, storeCode.trim(), catalogStateIds]
  )

  const map = new Map<number, SetQuantityCatalog>()
  for (const row of res.rows) {
    const catalog = mapSetQuantityRow(row)
    map.set(catalog.id, catalog)
  }
  return map
}

async function updateLocalQuantity(
  workspaceId:    string,
  storeId:        number,
  catalogStateId: number,
  quantity:       number
): Promise<void> {
  const result = await query(
    `UPDATE store_catalog_state
     SET ebay_quantity = $4,
         updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND store_id = $2::bigint
       AND id = $3::bigint`,
    [workspaceId, storeId, catalogStateId, quantity]
  )
  if (result.rowCount !== 1) {
    throw new Error("Local catalog quantity row was not updated")
  }
}

async function writeSetQuantityAudit(input: {
  actorUserId:    string
  success:        boolean
  workspaceId:    string
  store:          OwnedStore
  catalogStateId: number
  ebayItemId:     string | null
  quantity:       number
  oldQuantity?:   number
  batchId?:       string
  status?:        number
  outcome?:       QuantityOutcome
  reason?:        string
}): Promise<void> {
  try {
    const batchMeta = input.batchId ? { batchId: input.batchId } : {}

    await insertAuditLog({
      actorUserId: input.actorUserId,
      action: input.success
        ? "app.listings.set_quantity"
        : input.outcome === "uncertain"
          ? "app.listings.set_quantity.uncertain"
          : "app.listings.set_quantity.failed",
      targetType: "catalog_state",
      targetId:   String(input.catalogStateId),
      metadata: input.success
        ? {
            workspaceId:    input.workspaceId,
            storeCode:      input.store.storeCode,
            catalogStateId: input.catalogStateId,
            ebayItemId:     input.ebayItemId,
            oldQuantity:    input.oldQuantity ?? null,
            newQuantity:    input.quantity,
            actorUserId:    input.actorUserId,
            outcome:        "succeeded",
            ...batchMeta,
          }
        : {
            workspaceId:    input.workspaceId,
            storeCode:      input.store.storeCode,
            catalogStateId: input.catalogStateId,
            ebayItemId:     input.ebayItemId,
            newQuantity:    input.quantity,
            status:         input.status ?? 502,
            outcome:        input.outcome ?? "failed",
            reason:         input.reason?.slice(0, 200) ?? "Set quantity failed",
            ...batchMeta,
          },
    })
  } catch (e) {
    console.warn(
      "[App][listings-set-quantity] audit log failed:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

export function parseSetQuantityBody(body: Record<string, unknown>): number {
  if (body.confirm !== true) {
    throw new AppHttpError(400, "confirm must be true")
  }
  const raw = Number(body.quantity)
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || !ALLOWED_SET_QUANTITIES.has(raw)) {
    throw new AppHttpError(400, "quantity must be 0 or 1")
  }
  return raw
}

export function parseBulkSetQuantityCatalogStateIdsBody(body: Record<string, unknown>): number[] {
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
  if (ids.length > BULK_SET_QUANTITY_MAX) {
    throw new AppHttpError(400, `catalogStateIds must not exceed ${BULK_SET_QUANTITY_MAX}`)
  }

  return ids
}

async function assertEbayAccountConnected(
  workspaceId: string,
  store:       OwnedStore
): Promise<void> {
  try {
    await getValidAccessTokenByStoreId(workspaceId, store.id, false)
  } catch {
    throw new AppHttpError(400, "eBay account is not connected for this store")
  }
}

function quantityMutationError(quantity: number, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const safe = raw
    .replace(/Bearer\s+[^\s;]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
  return `Could not set quantity to ${quantity}: ${(safe || "eBay rejected the quantity update").slice(0, 220)}`
}


async function setQuantityForCatalog(input: {
  workspaceId: string
  actorUserId: string
  store:       OwnedStore
  catalog:     SetQuantityCatalog
  quantity:    number
  batchId?:    string
}): Promise<AppBulkSetListingQuantityItemResult> {
  const catalogStateId = input.catalog.id
  const oldQuantity = input.catalog.ebayQuantity

  if (input.catalog.currentStatus?.toLowerCase() === "ended") {
    await writeSetQuantityAudit({
      actorUserId: input.actorUserId,
      success: false,
      workspaceId: input.workspaceId,
      store: input.store,
      catalogStateId,
      ebayItemId: input.catalog.ebayItemId,
      quantity: input.quantity,
      batchId: input.batchId,
      status: 400,
      outcome: "failed",
      reason: "Ended listing cannot be updated.",
    })
    return {
      catalogStateId,
      ok:    false,
      outcome: "failed",
      error: "Ended listing cannot be updated.",
    }
  }

  if (!input.catalog.ebayItemId && !input.catalog.internalSku) {
    await writeSetQuantityAudit({
      actorUserId: input.actorUserId,
      success: false,
      workspaceId: input.workspaceId,
      store: input.store,
      catalogStateId,
      ebayItemId: null,
      quantity: input.quantity,
      batchId: input.batchId,
      status: 400,
      outcome: "failed",
      reason: "Listing is missing eBay item ID.",
    })
    return {
      catalogStateId,
      ok:    false,
      outcome: "failed",
      error: "Listing is missing eBay item ID.",
    }
  }

  if (!isQuantityMutationSourceEnabled("manual_listing")) {
    await writeSetQuantityAudit({
      actorUserId:    input.actorUserId,
      success:        false,
      workspaceId:    input.workspaceId,
      store:          input.store,
      catalogStateId,
      ebayItemId:     input.catalog.ebayItemId,
      quantity:       input.quantity,
      batchId:        input.batchId,
      status:         502,
      outcome:        "failed",
      reason:         quantityMutationDisabledMessage("manual_listing"),
    })
    return {
      catalogStateId,
      ok:    false,
      outcome: "failed",
      error: `Could not set quantity to ${input.quantity}: ${quantityMutationDisabledMessage("manual_listing")}.`,
    }
  }

  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"

  try {
    await setListingQuantityOnEbay(
      input.workspaceId,
      input.store.storeCode,
      {
        internalSku: input.catalog.internalSku,
        ebayItemId:  input.catalog.ebayItemId,
        ebayOfferId: input.catalog.ebayOfferId,
      },
      input.quantity,
      "manual_listing",
      sandbox,
      input.store.id
    )
  } catch (e) {
    const userError = quantityMutationError(input.quantity, e)
    const outcome: QuantityOutcome = e instanceof QuantityOutcomeUncertainError ? "uncertain" : "failed"
    await writeSetQuantityAudit({
      actorUserId:    input.actorUserId,
      success:        false,
      workspaceId:    input.workspaceId,
      store:          input.store,
      catalogStateId,
      ebayItemId:     input.catalog.ebayItemId,
      quantity:       input.quantity,
      batchId:        input.batchId,
      status:         502,
      outcome,
      reason:         userError.slice(0, 200),
    })
    return {
      catalogStateId,
      ok:    false,
      outcome,
      error: userError,
    }
  }

  // Local catalog quantity only updated after a successful eBay write.
  try {
    await updateLocalQuantity(input.workspaceId, input.store.id, catalogStateId, input.quantity)
  } catch (e) {
    const reason = "eBay accepted quantity but local catalog write is uncertain: " + (e instanceof Error ? e.message : String(e))
    await writeSetQuantityAudit({
      actorUserId: input.actorUserId,
      success: false,
      workspaceId: input.workspaceId,
      store: input.store,
      catalogStateId,
      ebayItemId: input.catalog.ebayItemId,
      quantity: input.quantity,
      batchId: input.batchId,
      status: 500,
      outcome: "uncertain",
      reason: reason.slice(0, 200),
    })
    return {
      catalogStateId,
      ok: false,
      outcome: "uncertain",
      ebayItemId: input.catalog.ebayItemId ?? undefined,
      error: reason,
    }
  }
  try {
    await afterManualQuantityChanged({
      workspaceId: input.workspaceId,
      storeId: input.store.id,
      catalogStateId,
      quantity: input.quantity,
    })
  } catch (e) {
    // eBay and local quantity are authoritative; lifecycle is best-effort.
    console.warn("[App][listings-set-quantity] lifecycle warning:", e instanceof Error ? e.message : String(e))
  }

  await writeSetQuantityAudit({
    actorUserId:    input.actorUserId,
    success:        true,
    workspaceId:    input.workspaceId,
    store:          input.store,
    catalogStateId,
    ebayItemId:     input.catalog.ebayItemId,
    quantity:       input.quantity,
    oldQuantity,
    batchId:        input.batchId,
  })

  return {
    catalogStateId,
    ok:          true,
    outcome:     "succeeded",
    ebayItemId:  input.catalog.ebayItemId ?? undefined,
    oldQuantity,
    newQuantity: input.quantity,
    message:     `Listing quantity was set to ${input.quantity}.`,
  }
}

export async function appSetListingQuantity(input: {
  workspaceId:    string
  actorUserId:    string
  store:          OwnedStore
  catalogStateId: number
  quantity:       number
}): Promise<AppSetListingQuantityResponse> {
  await assertEbayAccountConnected(input.workspaceId, input.store)

  const catalog = await loadSetQuantityCatalog(
    input.workspaceId,
    input.store.id,
    input.catalogStateId
  )
  if (!catalog) {
    throw new AppHttpError(404, "Listing not found")
  }

  const result = await setQuantityForCatalog({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    store:       input.store,
    catalog,
    quantity:    input.quantity,
  })

  if (!result.ok) {
    if (result.error?.startsWith("Could not set quantity to " + input.quantity + ":")) {
      throw new AppHttpError(502, result.error)
    }
    throw new AppHttpError(400, result.error ?? "Could not set quantity")
  }

  return {
    ok:             true,
    storeCode:      input.store.storeCode,
    catalogStateId: catalog.id,
    ebayItemId:     result.ebayItemId,
    oldQuantity:    result.oldQuantity ?? 0,
    newQuantity:    input.quantity,
    message:        result.message ?? `Listing quantity was set to ${input.quantity}.`,
  }
}

export async function appBulkSetListingQuantity(input: {
  workspaceId:     string
  actorUserId:     string
  store:           OwnedStore
  catalogStateIds: number[]
  quantity:        number
}): Promise<AppBulkSetListingQuantityResponse> {
  await assertEbayAccountConnected(input.workspaceId, input.store)

  const batchId = randomUUID()
  const catalogMap = await loadSetQuantityCatalogByIds(
    input.workspaceId,
    input.store.id,
    input.store.storeCode,
    input.catalogStateIds
  )

  const startedAt = Date.now()
  console.log("[App][bulk-set-quantity] start batch=" + batchId + " store=" + input.store.storeCode + " requested=" + input.catalogStateIds.length + " quantity=" + input.quantity)
  const results = new Array<AppBulkSetListingQuantityItemResult>(input.catalogStateIds.length)
  let nextIndex = 0
  const workerCount = Math.min(BULK_SET_QUANTITY_CONCURRENCY, input.catalogStateIds.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++
      if (index >= input.catalogStateIds.length) return
      const catalogStateId = input.catalogStateIds[index]
      const catalog = catalogMap.get(catalogStateId)
      if (!catalog) {
        results[index] = { catalogStateId, ok: false, outcome: "failed", error: "Listing not found." }
        await writeSetQuantityAudit({
          actorUserId: input.actorUserId,
          success: false,
          workspaceId: input.workspaceId,
          store: input.store,
          catalogStateId,
          ebayItemId: null,
          quantity: input.quantity,
          batchId,
          status: 404,
          outcome: "failed",
          reason: "Listing not found.",
        })
        continue
      }
      try {
        results[index] = await setQuantityForCatalog({
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          store: input.store,
          catalog,
          quantity: input.quantity,
          batchId,
        })
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        const outcome: QuantityOutcome = e instanceof QuantityOutcomeUncertainError ? "uncertain" : "failed"
        results[index] = { catalogStateId, ok: false, outcome, ebayItemId: catalog.ebayItemId ?? undefined, error: reason.slice(0, 260) }
        await writeSetQuantityAudit({
          actorUserId: input.actorUserId,
          success: false,
          workspaceId: input.workspaceId,
          store: input.store,
          catalogStateId,
          ebayItemId: catalog.ebayItemId,
          quantity: input.quantity,
          batchId,
          status: 500,
          outcome,
          reason,
        })
      }
    }
  }))

  const succeeded = results.filter(r => r.outcome === "succeeded").length
  const failed = results.filter(r => r.outcome === "failed").length
  const uncertain = results.filter(r => r.outcome === "uncertain").length
  const durationMs = Date.now() - startedAt
  try {
    await insertAuditLog({
      actorUserId: input.actorUserId,
      action: failed + uncertain > 0 ? "app.bulk.listings.set_quantity.failed" : "app.bulk.listings.set_quantity",
      targetType: "bulk_quantity_batch",
      targetId: batchId,
      metadata: {
        workspaceId: input.workspaceId,
        storeCode: input.store.storeCode,
        batchId,
        quantity: input.quantity,
        requested: input.catalogStateIds.length,
        succeeded,
        failed,
        uncertain,
        durationMs,
      },
    })
  } catch (e) {
    console.warn("[App][bulk-set-quantity] batch audit failed:", e instanceof Error ? e.message : String(e))
  }
  console.log("[App][bulk-set-quantity] complete batch=" + batchId + " store=" + input.store.storeCode + " requested=" + input.catalogStateIds.length + " succeeded=" + succeeded + " failed=" + failed + " uncertain=" + uncertain + " durationMs=" + durationMs)

  return {
    ok:          true,
    storeCode:   input.store.storeCode,
    batchId,
    quantity:    input.quantity,
    requested:   input.catalogStateIds.length,
    succeeded,
    failed,
    uncertain,
    results,
  }
}
