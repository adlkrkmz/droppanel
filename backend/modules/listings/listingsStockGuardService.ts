import { query } from "../../db/client"
import { afterListingMonitoringStopped } from "../stockGuard/stockGuardV2LifecycleHooks"
import type {
  ListingActionResult,
  ListingItemRef,
  RemoveFromListResponse,
  RestoreToListResponse,
  SourceStatusRequest,
  SourceStatusResponse,
  SourceStatusValue,
  StockGuardRequest,
  StockGuardResponse,
} from "./listingsStockGuardTypes"
import { isSourceStatusValue } from "./listingsStockGuardTypes"

type StoreRow = { id: number; name: string }

async function getStoreByCode(
  workspaceId: string,
  storeCode:   string
): Promise<StoreRow | null> {
  const result = await query<StoreRow>(
    `SELECT id, name FROM stores
     WHERE workspace_id = $1 AND store_code = $2 AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  return result.rows[0] ?? null
}

function normalizeEbayIds(items: ListingItemRef[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const id = String(item.ebayItemId ?? "").trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function normalizeCatalogIds(items: ListingItemRef[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const item of items) {
    const id = item.catalogStateId
    if (id == null || id <= 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

async function updateByCatalogIds(
  workspaceId: string,
  storeId:     number,
  catalogIds:  number[],
  setClause:   string,
  params:      unknown[]
): Promise<ListingActionResult[]> {
  const results: ListingActionResult[] = []
  if (catalogIds.length === 0) return results

  const foundRes = await query<{ id: string }>(
    `SELECT id::text AS id
     FROM store_catalog_state
     WHERE workspace_id = $1
       AND store_id = $2
       AND id = ANY($3::bigint[])`,
    [workspaceId, storeId, catalogIds]
  )
  const foundSet = new Set(foundRes.rows.map(r => parseInt(r.id, 10)))

  for (const catalogStateId of catalogIds) {
    if (!foundSet.has(catalogStateId)) {
      results.push({ catalogStateId, status: "NOT_FOUND", message: "Listing not found in store" })
    }
  }

  if (foundSet.size === 0) return results

  const idsToUpdate = catalogIds.filter(id => foundSet.has(id))
  await query(
    `UPDATE store_catalog_state
     SET ${setClause}, updated_at = NOW()
     WHERE workspace_id = $1
       AND store_id = $2
       AND id = ANY($3::bigint[])`,
    [workspaceId, storeId, idsToUpdate, ...params]
  )

  for (const catalogStateId of idsToUpdate) {
    results.push({ catalogStateId, status: "UPDATED" })
  }

  return results
}

function summarize(results: ListingActionResult[]): Omit<StockGuardResponse, "ok"> {
  let updated = 0
  let notFound = 0
  for (const r of results) {
    if (r.status === "UPDATED") updated++
    else notFound++
  }
  return { updated, notFound, results }
}

async function updateByEbayIds(
  workspaceId: string,
  storeId:     number,
  ebayIds:     string[],
  setClause:   string,
  params:      unknown[]
): Promise<ListingActionResult[]> {
  const results: ListingActionResult[] = []
  if (ebayIds.length === 0) return results

  const foundRes = await query<{ ebay_item_id: string }>(
    `SELECT trim(ebay_item_id) AS ebay_item_id
     FROM store_catalog_state
     WHERE workspace_id = $1
       AND store_id = $2
       AND trim(ebay_item_id) = ANY($3::text[])`,
    [workspaceId, storeId, ebayIds]
  )
  const foundSet = new Set(foundRes.rows.map(r => r.ebay_item_id))

  for (const ebayItemId of ebayIds) {
    if (!foundSet.has(ebayItemId)) {
      results.push({ ebayItemId, status: "NOT_FOUND", message: "Listing not found in store" })
    }
  }

  if (foundSet.size === 0) return results

  const idsToUpdate = ebayIds.filter(id => foundSet.has(id))
  await query(
    `UPDATE store_catalog_state
     SET ${setClause}, updated_at = NOW()
     WHERE workspace_id = $1
       AND store_id = $2
       AND trim(ebay_item_id) = ANY($3::text[])`,
    [workspaceId, storeId, idsToUpdate, ...params]
  )

  for (const ebayItemId of idsToUpdate) {
    results.push({ ebayItemId, status: "UPDATED" })
  }

  return results
}

export async function setStockGuard(
  workspaceId: string,
  req:         StockGuardRequest
): Promise<StockGuardResponse> {
  const store = await getStoreByCode(workspaceId, req.storeCode)
  if (!store) throw new Error("Active store not found")

  const ebayIds = normalizeEbayIds(req.items)
  const catalogIds = normalizeCatalogIds(req.items)
  const enabled = Boolean(req.enabled)

  const results = [
    ...(await updateByEbayIds(
      workspaceId,
      store.id,
      ebayIds,
      "stock_guard_enabled = $4",
      [enabled]
    )),
    ...(await updateByCatalogIds(
      workspaceId,
      store.id,
      catalogIds,
      "stock_guard_enabled = $4",
      [enabled]
    )),
  ]

  if (!enabled) {
    const stoppedCatalogIds = results
      .filter(r => r.status === "UPDATED" && r.catalogStateId != null)
      .map(r => r.catalogStateId as number)
    const stoppedEbayIds = results
      .filter(r => r.status === "UPDATED" && r.ebayItemId)
      .map(r => String(r.ebayItemId))
    if (stoppedCatalogIds.length > 0 || stoppedEbayIds.length > 0) {
      await afterListingMonitoringStopped({
        workspaceId,
        catalogStateIds: stoppedCatalogIds,
        ebayItemIds: stoppedEbayIds,
        reason: "GUARD_DISABLED",
      })
    }
  }

  return { ok: true, ...summarize(results) }
}

export async function removeFromList(
  workspaceId: string,
  storeCode:   string,
  items:       { ebayItemId: string }[]
): Promise<RemoveFromListResponse> {
  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error("Active store not found")

  const ebayIds = normalizeEbayIds(items)
  const results = await updateByEbayIds(
    workspaceId,
    store.id,
    ebayIds,
    "panel_hidden_at = NOW()",
    []
  )

  return { ok: true, ...summarize(results) }
}

export async function restoreToList(
  workspaceId: string,
  storeCode:   string,
  items:       { ebayItemId: string }[]
): Promise<RestoreToListResponse> {
  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error("Active store not found")

  const ebayIds = normalizeEbayIds(items)
  const results = await updateByEbayIds(
    workspaceId,
    store.id,
    ebayIds,
    "panel_hidden_at = NULL",
    []
  )

  return { ok: true, ...summarize(results) }
}

export async function setSourceStatus(
  workspaceId: string,
  req:         SourceStatusRequest
): Promise<SourceStatusResponse> {
  const store = await getStoreByCode(workspaceId, req.storeCode)
  if (!store) throw new Error("Active store not found")

  const status = String(req.sourceStatus ?? "").trim().toUpperCase()
  if (!isSourceStatusValue(status)) {
    throw new Error(`Invalid sourceStatus: ${status}`)
  }

  const reason = req.sourceStatusReason?.trim() || null
  const ebayIds = normalizeEbayIds(req.items)

  const results = await updateByEbayIds(
    workspaceId,
    store.id,
    ebayIds,
    "source_status = $4, source_status_reason = $5, source_checked_at = NOW()",
    [status as SourceStatusValue, reason]
  )

  return { ok: true, ...summarize(results) }
}
