// ----------------------------------------------------------------
// appListingStockGuardService.ts — user-scoped per-listing Stock Guard toggle (Phase 5G)
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { insertAuditLog } from "../auth/authRepository"
import { resolveListingAsin } from "../monitor/monitorService"
import { afterListingMonitoringStopped } from "../stockGuard/stockGuardV2LifecycleHooks"
import type { OwnedStore } from "./appOwnership"
import type { AppListingStockGuardUpdateResponse } from "./appTypes"
import { AppHttpError } from "./appTypes"

export type ListingStockGuardRow = {
  id:                number
  storeId:           number
  ebayItemId:        string | null
  asin:              string | null
  currentStatus:     string | null
  stockGuardEnabled: boolean
}

export type AppListingStockGuardItemResult = {
  catalogStateId:   number
  ok:               boolean
  stockGuardEnabled?: boolean
  message?:         string
  error?:           string
}

async function loadListingForStockGuardToggle(
  workspaceId:    string,
  storeCode:      string,
  catalogStateId: number
): Promise<ListingStockGuardRow | null> {
  const res = await query<{
    id: number
    store_id: number
    ebay_item_id: string | null
    registry_asin: string | null
    source_url: string | null
    internal_sku: string
    current_status: string | null
    stock_guard_enabled: boolean
  }>(
    `SELECT scs.id,
            scs.store_id,
            scs.ebay_item_id,
            ar.asin AS registry_asin,
            scs.source_url,
            scs.internal_sku,
            scs.current_status::text AS current_status,
            COALESCE(scs.stock_guard_enabled, true) AS stock_guard_enabled
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

  return mapListingStockGuardRow(row)
}

function mapListingStockGuardRow(row: {
  id: number
  store_id: number
  ebay_item_id: string | null
  registry_asin: string | null
  source_url: string | null
  internal_sku: string
  current_status: string | null
  stock_guard_enabled: boolean
}): ListingStockGuardRow {
  return {
    id:                row.id,
    storeId:           row.store_id,
    ebayItemId:        row.ebay_item_id?.trim() || null,
    asin: resolveListingAsin({
      registryAsin: row.registry_asin,
      sourceUrl:    row.source_url,
      internalSku:  row.internal_sku?.trim() ?? "",
    }),
    currentStatus:     row.current_status?.trim() || null,
    stockGuardEnabled: row.stock_guard_enabled !== false,
  }
}

export async function loadOwnedListingsForStockGuardByIds(
  workspaceId:     string,
  storeId:         number,
  storeCode:       string,
  catalogStateIds: number[]
): Promise<Map<number, ListingStockGuardRow>> {
  if (catalogStateIds.length === 0) return new Map()

  const res = await query<{
    id: number
    store_id: number
    ebay_item_id: string | null
    registry_asin: string | null
    source_url: string | null
    internal_sku: string
    current_status: string | null
    stock_guard_enabled: boolean
  }>(
    `SELECT scs.id,
            scs.store_id,
            scs.ebay_item_id,
            ar.asin AS registry_asin,
            scs.source_url,
            scs.internal_sku,
            scs.current_status::text AS current_status,
            COALESCE(scs.stock_guard_enabled, true) AS stock_guard_enabled
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

  const map = new Map<number, ListingStockGuardRow>()
  for (const row of res.rows) {
    map.set(row.id, mapListingStockGuardRow(row))
  }
  return map
}

async function writeStockGuardAudit(input: {
  actorUserId:               string
  success:                   boolean
  workspaceId:               string
  store:                     OwnedStore
  catalogStateId:            number
  ebayItemId?:               string | null
  asin?:                     string | null
  previousStockGuardEnabled?: boolean
  newStockGuardEnabled?:     boolean
  batchId?:                  string
  status?:                   number
  reason?:                   string
}): Promise<void> {
  try {
    const batchMeta = input.batchId ? { batchId: input.batchId } : {}

    await insertAuditLog({
      actorUserId: input.actorUserId,
      action: input.success
        ? "app.listings.stock_guard.update"
        : "app.listings.stock_guard.update.failed",
      targetType: "catalog_state",
      targetId:   String(input.catalogStateId),
      metadata: input.success
        ? {
            workspaceId:               input.workspaceId,
            storeCode:                 input.store.storeCode,
            catalogStateId:            input.catalogStateId,
            ebayItemId:                input.ebayItemId ?? null,
            asin:                      input.asin ?? null,
            previousStockGuardEnabled: input.previousStockGuardEnabled,
            newStockGuardEnabled:      input.newStockGuardEnabled,
            actorUserId:               input.actorUserId,
            ...batchMeta,
          }
        : {
            storeCode:      input.store.storeCode,
            catalogStateId: input.catalogStateId,
            status:         input.status ?? 400,
            reason:         input.reason?.slice(0, 200) ?? "Stock Guard update failed",
            ...batchMeta,
          },
    })
  } catch (e) {
    console.warn(
      "[App][listings-stock-guard] audit log failed:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

export function parseStockGuardEnabledBody(body: Record<string, unknown>): boolean {
  if (typeof body.enabled !== "boolean") {
    throw new AppHttpError(400, "enabled must be a boolean")
  }
  return body.enabled
}

export async function updateOwnedListingStockGuardItem(input: {
  workspaceId: string
  actorUserId: string
  store:       OwnedStore
  listing:     ListingStockGuardRow
  enabled:     boolean
  batchId?:    string
}): Promise<AppListingStockGuardItemResult> {
  const catalogStateId = input.listing.id

  if (input.listing.currentStatus?.toLowerCase() === "ended") {
    await writeStockGuardAudit({
      actorUserId:    input.actorUserId,
      success:        false,
      workspaceId:    input.workspaceId,
      store:          input.store,
      catalogStateId,
      batchId:        input.batchId,
      status:         400,
      reason:         "Ended listing cannot be monitored by Stock Guard.",
    })
    return {
      catalogStateId,
      ok:    false,
      error: "Ended listing cannot be monitored by Stock Guard.",
    }
  }

  const previousStockGuardEnabled = input.listing.stockGuardEnabled

  if (previousStockGuardEnabled === input.enabled) {
    return {
      catalogStateId,
      ok:                true,
      stockGuardEnabled: input.enabled,
      message:           input.enabled
        ? "Stock Guard is already enabled."
        : "Stock Guard is already disabled.",
    }
  }

  await query(
    `UPDATE store_catalog_state
     SET stock_guard_enabled = $4,
         updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND store_id = $2::bigint
       AND id = $3::bigint`,
    [input.workspaceId, input.store.id, input.listing.id, input.enabled]
  )

  if (!input.enabled) {
    await afterListingMonitoringStopped({
      workspaceId: input.workspaceId,
      catalogStateIds: [input.listing.id],
      reason: "GUARD_DISABLED",
    })
  }

  await writeStockGuardAudit({
    actorUserId:              input.actorUserId,
    success:                  true,
    workspaceId:              input.workspaceId,
    store:                    input.store,
    catalogStateId,
    ebayItemId:               input.listing.ebayItemId,
    asin:                     input.listing.asin,
    previousStockGuardEnabled,
    newStockGuardEnabled:     input.enabled,
    batchId:                  input.batchId,
  })

  return {
    catalogStateId,
    ok:                true,
    stockGuardEnabled: input.enabled,
    message:           input.enabled ? "Stock Guard enabled." : "Stock Guard disabled.",
  }
}

export async function appUpdateListingStockGuard(input: {
  workspaceId:    string
  actorUserId:    string
  store:          OwnedStore
  catalogStateId: number
  enabled:        boolean
}): Promise<AppListingStockGuardUpdateResponse> {
  const listing = await loadListingForStockGuardToggle(
    input.workspaceId,
    input.store.storeCode,
    input.catalogStateId
  )

  if (!listing) {
    throw new AppHttpError(404, "Listing not found")
  }

  const result = await updateOwnedListingStockGuardItem({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    store:       input.store,
    listing,
    enabled:     input.enabled,
  })

  if (!result.ok) {
    throw new AppHttpError(400, result.error ?? "Stock Guard update failed")
  }

  return {
    ok:                true,
    storeCode:         input.store.storeCode,
    catalogStateId:    listing.id,
    stockGuardEnabled: input.enabled,
    message:           result.message?.includes("already")
      ? result.message
      : input.enabled
        ? "Stock Guard enabled for this listing."
        : "Stock Guard disabled for this listing.",
  }
}
