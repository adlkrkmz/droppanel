// ----------------------------------------------------------------
// appListingHideService.ts — user-scoped listing panel hide (Phase 5O)
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { insertAuditLog } from "../auth/authRepository"
import { resolveListingAsin } from "../monitor/monitorService"
import type { OwnedStore } from "./appOwnership"

export type ListingHideRow = {
  id:            number
  ebayItemId:    string | null
  asin:          string | null
  panelHiddenAt: string | null
}

export type AppListingHideItemResult = {
  catalogStateId: number
  ok:             boolean
  hidden?:        boolean
  message?:       string
  error?:         string
}

function mapListingHideRow(row: {
  id: number | string
  ebay_item_id: string | null
  registry_asin: string | null
  source_url: string | null
  internal_sku: string
  panel_hidden_at: string | null
}): ListingHideRow {
  return {
    // pg returns bigint as string — Map lookups use numeric catalogStateIds from the request.
    id:            Number(row.id),
    ebayItemId:    row.ebay_item_id?.trim() || null,
    asin: resolveListingAsin({
      registryAsin: row.registry_asin,
      sourceUrl:    row.source_url,
      internalSku:  row.internal_sku?.trim() ?? "",
    }),
    panelHiddenAt: row.panel_hidden_at?.trim() || null,
  }
}

export async function loadOwnedListingsForHideByIds(
  workspaceId:     string,
  storeId:         number,
  storeCode:       string,
  catalogStateIds: number[]
): Promise<Map<number, ListingHideRow>> {
  if (catalogStateIds.length === 0) return new Map()

  const res = await query<{
    id: number
    ebay_item_id: string | null
    registry_asin: string | null
    source_url: string | null
    internal_sku: string
    panel_hidden_at: string | null
  }>(
    `SELECT scs.id,
            scs.ebay_item_id,
            ar.asin AS registry_asin,
            scs.source_url,
            scs.internal_sku,
            scs.panel_hidden_at::text AS panel_hidden_at
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id AND s.workspace_id = scs.workspace_id
     LEFT JOIN asin_registry ar ON ar.id = scs.asin_registry_id
     WHERE scs.workspace_id = $1::uuid
       AND scs.store_id = $2::bigint
       AND s.store_code = $3
       AND s.status = 'active'
       AND scs.id = ANY($4::bigint[])`,
    [workspaceId, storeId, storeCode.trim(), catalogStateIds]
  )

  const map = new Map<number, ListingHideRow>()
  for (const row of res.rows) {
    const mapped = mapListingHideRow(row)
    if (!Number.isFinite(mapped.id) || mapped.id <= 0) continue
    map.set(mapped.id, mapped)
  }
  return map
}

async function writeHideAudit(input: {
  actorUserId:           string
  success:               boolean
  workspaceId:           string
  store:                 OwnedStore
  catalogStateId:        number
  ebayItemId?:           string | null
  asin?:                 string | null
  previousPanelHiddenAt?: string | null
  newPanelHiddenAt?:     string | null
  batchId?:              string
  status?:               number
  reason?:               string
}): Promise<void> {
  try {
    const batchMeta = input.batchId ? { batchId: input.batchId } : {}

    await insertAuditLog({
      actorUserId: input.actorUserId,
      action: input.success ? "app.listings.hide" : "app.listings.hide.failed",
      targetType: "catalog_state",
      targetId:   String(input.catalogStateId),
      metadata: input.success
        ? {
            workspaceId:           input.workspaceId,
            storeCode:             input.store.storeCode,
            catalogStateId:        input.catalogStateId,
            ebayItemId:            input.ebayItemId ?? null,
            asin:                  input.asin ?? null,
            previousPanelHiddenAt: input.previousPanelHiddenAt ?? null,
            newPanelHiddenAt:      input.newPanelHiddenAt ?? null,
            actorUserId:           input.actorUserId,
            ...batchMeta,
          }
        : {
            storeCode:      input.store.storeCode,
            catalogStateId: input.catalogStateId,
            status:         input.status ?? 400,
            reason:         input.reason?.slice(0, 200) ?? "Hide listing failed",
            ...batchMeta,
          },
    })
  } catch (e) {
    console.warn(
      "[App][listings-hide] audit log failed:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

export async function hideOwnedListingItem(input: {
  workspaceId: string
  actorUserId: string
  store:       OwnedStore
  listing:     ListingHideRow
  batchId?:    string
}): Promise<AppListingHideItemResult> {
  const catalogStateId = input.listing.id

  if (input.listing.panelHiddenAt) {
    return {
      catalogStateId,
      ok:      true,
      hidden:  true,
      message: "Listing is already hidden.",
    }
  }

  await query(
    `UPDATE store_catalog_state
     SET panel_hidden_at = NOW(),
         updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND store_id = $2::bigint
       AND id = $3::bigint`,
    [input.workspaceId, input.store.id, input.listing.id]
  )

  await writeHideAudit({
    actorUserId:           input.actorUserId,
    success:               true,
    workspaceId:           input.workspaceId,
    store:                 input.store,
    catalogStateId,
    ebayItemId:            input.listing.ebayItemId,
    asin:                  input.listing.asin,
    previousPanelHiddenAt: null,
    newPanelHiddenAt:      new Date().toISOString(),
    batchId:               input.batchId,
  })

  return {
    catalogStateId,
    ok:      true,
    hidden:  true,
    message: "Listing hidden from panel.",
  }
}
