// ----------------------------------------------------------------
// appOwnership.ts — user workspace ownership guards (Phase 2)
// Never uses process.env.WORKSPACE_ID — JWT workspaceId only.
// ----------------------------------------------------------------

import { query } from "../../db/client"
import type { AuthedRequest } from "../auth/authMiddleware"
import { AppHttpError } from "./appTypes"

export type OwnedStore = {
  id:        number
  name:      string
  storeCode: string
  status:    string
}

export function getAuthenticatedWorkspaceId(req: AuthedRequest): string {
  const workspaceId = req.auth?.user?.workspaceId
  if (!workspaceId?.trim()) {
    throw new AppHttpError(403, "Workspace not found")
  }
  return workspaceId
}

export async function assertStoreInUserWorkspace(
  workspaceId: string,
  storeCode:   string
): Promise<OwnedStore> {
  const code = storeCode?.trim()
  if (!code) {
    throw new AppHttpError(400, "storeCode is required")
  }

  const res = await query<{
    id: number
    name: string
    store_code: string
    status: string
  }>(
    `SELECT id, name, store_code, status
     FROM stores
     WHERE workspace_id = $1::uuid
       AND store_code = $2
       AND status = 'active'
     ORDER BY id ASC`,
    [workspaceId, code]
  )

  if (res.rows.length === 0) {
    throw new AppHttpError(404, "Store not found")
  }
  if (res.rows.length > 1) {
    throw new AppHttpError(409, "Ambiguous storeCode; use storeId")
  }

  const row = res.rows[0]
  return {
    id:        row.id,
    name:      row.name,
    storeCode: row.store_code,
    status:    row.status,
  }
}

/**
 * Extension mutations: prefer exact storeId (workspace-scoped).
 * Legacy storeCode only when it resolves to exactly one active store.
 */
export async function resolveOwnedStoreForExtension(
  workspaceId: string,
  input: { storeId?: unknown; storeCode?: unknown }
): Promise<OwnedStore> {
  const rawId = input.storeId
  const n =
    typeof rawId === "number" ? rawId
    : typeof rawId === "string" && rawId.trim() !== "" ? Number(rawId)
    : NaN
  if (Number.isInteger(n) && n > 0) {
    return assertStoreIdInUserWorkspace(workspaceId, n)
  }
  const code = String(input.storeCode ?? "").trim()
  if (!code) {
    throw new AppHttpError(400, "storeId or storeCode is required")
  }
  return assertStoreInUserWorkspace(workspaceId, code)
}

/** Resolve by numeric store id within the authenticated workspace (active only). */
export async function assertStoreIdInUserWorkspace(
  workspaceId: string,
  storeId:     number
): Promise<OwnedStore> {
  if (!Number.isInteger(storeId) || storeId < 1) {
    throw new AppHttpError(400, "storeId is required")
  }

  const res = await query<{
    id: number
    name: string
    store_code: string
    status: string
  }>(
    `SELECT id, name, store_code, status
     FROM stores
     WHERE workspace_id = $1::uuid
       AND id = $2
       AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeId]
  )

  const row = res.rows[0]
  if (!row) {
    throw new AppHttpError(404, "Store not found")
  }

  return {
    id:        row.id,
    name:      row.name,
    storeCode: row.store_code,
    status:    row.status,
  }
}

export async function assertCatalogStateInUserWorkspace(
  workspaceId:    string,
  catalogStateId: number
): Promise<{ id: number; storeId: number; storeCode: string }> {
  if (!Number.isFinite(catalogStateId) || catalogStateId <= 0) {
    throw new AppHttpError(400, "catalogStateId is required")
  }

  const res = await query<{
    id: number
    store_id: number
    store_code: string
  }>(
    `SELECT scs.id, scs.store_id, s.store_code
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id
     WHERE scs.id = $1::bigint
       AND scs.workspace_id = $2::uuid
       AND s.workspace_id = $2::uuid
     LIMIT 1`,
    [catalogStateId, workspaceId]
  )

  const row = res.rows[0]
  if (!row) {
    throw new AppHttpError(404, "Listing not found")
  }

  return { id: row.id, storeId: row.store_id, storeCode: row.store_code }
}

export async function assertCatalogStateInUserWorkspaceStore(
  workspaceId:    string,
  storeCode:      string,
  catalogStateId: number
): Promise<{ id: number; storeId: number; storeCode: string }> {
  if (!Number.isFinite(catalogStateId) || catalogStateId <= 0) {
    throw new AppHttpError(400, "catalogStateId is required")
  }

  const code = storeCode?.trim()
  if (!code) {
    throw new AppHttpError(400, "storeCode is required")
  }

  const res = await query<{
    id: number
    store_id: number
    store_code: string
  }>(
    `SELECT scs.id, scs.store_id, s.store_code
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id AND s.workspace_id = scs.workspace_id
     WHERE scs.id = $1::bigint
       AND scs.workspace_id = $2::uuid
       AND s.workspace_id = $2::uuid
       AND s.store_code = $3
       AND s.status = 'active'
     LIMIT 1`,
    [catalogStateId, workspaceId, code]
  )

  const row = res.rows[0]
  if (!row) {
    throw new AppHttpError(404, "Listing not found")
  }

  return { id: row.id, storeId: row.store_id, storeCode: row.store_code }
}

export async function assertEbayItemInUserWorkspace(
  workspaceId: string,
  ebayItemId:  string
): Promise<{ catalogStateId: number; storeId: number; storeCode: string }> {
  const itemId = ebayItemId?.trim()
  if (!itemId) {
    throw new AppHttpError(400, "ebayItemId is required")
  }

  const res = await query<{
    id: number
    store_id: number
    store_code: string
  }>(
    `SELECT scs.id, scs.store_id, s.store_code
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id
     WHERE scs.ebay_item_id = $1
       AND scs.workspace_id = $2::uuid
       AND s.workspace_id = $2::uuid
     LIMIT 1`,
    [itemId, workspaceId]
  )

  const row = res.rows[0]
  if (!row) {
    throw new AppHttpError(404, "Listing not found")
  }

  return {
    catalogStateId: row.id,
    storeId:        row.store_id,
    storeCode:      row.store_code,
  }
}

export type OwnedStockAlert = {
  id:                 number
  storeId:            number
  catalogStateId:     number
  ebayItemId:         string | null
  asin:               string
  reviewStatus:       string
  sourceStatus:       string
  sourceStatusReason: string | null
}

export async function assertStockAlertInUserWorkspaceStore(
  workspaceId: string,
  storeCode:   string,
  alertId:     number
): Promise<OwnedStockAlert> {
  if (!Number.isFinite(alertId) || alertId <= 0) {
    throw new AppHttpError(400, "alertId is required")
  }

  const code = storeCode?.trim()
  if (!code) {
    throw new AppHttpError(400, "storeCode is required")
  }

  const res = await query<{
    id: number
    store_id: number
    catalog_state_id: number
    ebay_item_id: string | null
    asin: string
    review_status: string
    source_status: string
    source_status_reason: string | null
  }>(
    `SELECT
       sri.id,
       sri.store_id,
       sri.catalog_state_id,
       sri.ebay_item_id,
       sri.asin,
       sri.review_status,
       sri.source_status,
       sri.source_status_reason
     FROM stock_review_items sri
     INNER JOIN stores s
       ON s.id = sri.store_id
      AND s.workspace_id = sri.workspace_id
     WHERE sri.id = $1::bigint
       AND sri.workspace_id = $2::uuid
       AND s.workspace_id = $2::uuid
       AND s.store_code = $3
       AND s.status = 'active'
     LIMIT 1`,
    [alertId, workspaceId, code]
  )

  const row = res.rows[0]
  if (!row) {
    throw new AppHttpError(404, "Alert not found")
  }

  return {
    id:                 row.id,
    storeId:            row.store_id,
    catalogStateId:     row.catalog_state_id,
    ebayItemId:         row.ebay_item_id?.trim() || null,
    asin:               row.asin,
    reviewStatus:       row.review_status,
    sourceStatus:       row.source_status,
    sourceStatusReason: row.source_status_reason?.trim() || null,
  }
}
