// ----------------------------------------------------------------
// soldItemAutoRestockRepository.ts — DB helpers for sold-item restock
// ----------------------------------------------------------------

import { query } from "../../db/client"

export type RestockStore = {
  storeId:   number
  storeCode: string
  name:      string
}

export type CatalogListingRow = {
  catalogStateId: number
  internalSku:    string | null
  ebayItemId:     string | null
  ebayOfferId:    string | null
  ebayQuantity:   number | null
}

export type RestockAction =
  | "restocked"
  | "skipped_not_zero"
  | "skipped_no_catalog"
  | "skipped_check_failed"
  | "skipped_old_order"
  | "skipped_variation_not_supported"
  | "skipped_quantity_unknown"
  | "failed"

/** Active eBay stores with OAuth — dynamic, not hardcoded. */
export async function listActiveEbayStores(
  workspaceId: string,
  storeCode?: string
): Promise<RestockStore[]> {
  const params: unknown[] = [workspaceId]
  let storeFilter = ""
  if (storeCode?.trim()) {
    params.push(storeCode.trim())
    storeFilter = ` AND s.store_code = $${params.length}`
  }

  const res = await query<{ id: number; store_code: string; name: string }>(
    `SELECT s.id, s.store_code, s.name
     FROM stores s
     INNER JOIN ebay_accounts ea
       ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id
     WHERE s.workspace_id = $1::uuid
       AND s.status = 'active'
       AND COALESCE(s.marketplace, 'ebay') = 'ebay'
       ${storeFilter}
     ORDER BY s.id`,
    params
  )

  return res.rows.map((r) => ({
    storeId:   Number(r.id),
    storeCode: r.store_code,
    name:      r.name,
  }))
}

/** Platform-wide: every active eBay store across all workspaces (exact store_id). */
export async function listAllActiveEbayStores(): Promise<Array<RestockStore & { workspaceId: string }>> {
  const res = await query<{
    workspace_id: string
    id: number
    store_code: string
    name: string
  }>(
    `SELECT s.workspace_id::text AS workspace_id, s.id, s.store_code, s.name
     FROM stores s
     INNER JOIN ebay_accounts ea
       ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id
     WHERE s.status = 'active'
       AND COALESCE(s.marketplace, 'ebay') = 'ebay'
       AND ea.refresh_token IS NOT NULL
     ORDER BY s.workspace_id, s.id`
  )

  return res.rows.map((r) => ({
    workspaceId: r.workspace_id,
    storeId:     Number(r.id),
    storeCode:   r.store_code,
    name:        r.name,
  }))
}

/**
 * Terminal events that must not be retried.
 * failed / skipped_check_failed / skipped_no_catalog remain retryable.
 */
const TERMINAL_RESTOCK_ACTIONS = [
  "restocked",
  "skipped_not_zero",
  "skipped_old_order",
  "skipped_variation_not_supported",
  "skipped_quantity_unknown",
] as const

export async function hasBlockingRestockEvent(
  workspaceId:     string,
  storeId:         number,
  ebayOrderId:     string,
  ebayLineItemId:  string
): Promise<boolean> {
  const res = await query<{ ok: number }>(
    `SELECT 1 AS ok
     FROM sold_item_restock_events
     WHERE workspace_id = $1::uuid
       AND store_id = $2
       AND ebay_order_id = $3
       AND ebay_line_item_id = $4
       AND action = ANY($5::text[])
     LIMIT 1`,
    [workspaceId, storeId, ebayOrderId, ebayLineItemId, [...TERMINAL_RESTOCK_ACTIONS]]
  )
  return (res.rowCount ?? 0) > 0
}

/** @deprecated Use hasBlockingRestockEvent — any-row check permanently blocked FAILED retries. */
export async function hasRestockEvent(
  workspaceId:     string,
  storeId:         number,
  ebayOrderId:     string,
  ebayLineItemId:  string
): Promise<boolean> {
  return hasBlockingRestockEvent(workspaceId, storeId, ebayOrderId, ebayLineItemId)
}

export async function insertRestockEvent(input: {
  workspaceId:      string
  storeId:          number
  ebayOrderId:      string
  ebayLineItemId:   string
  sku:              string | null
  ebayItemId:       string | null
  ebayOfferId:      string | null
  catalogStateId:   number | null
  checkedQuantity:  number | null
  action:           RestockAction
  errorMessage?:    string | null
  restockedAt?:     Date | null
}): Promise<boolean> {
  try {
    const res = await query(
      `INSERT INTO sold_item_restock_events (
         workspace_id, store_id, ebay_order_id, ebay_line_item_id,
         sku, ebay_item_id, ebay_offer_id, catalog_state_id,
         checked_quantity, action, status, checked_at, restocked_at, error_message
       )
       VALUES (
         $1::uuid, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10, 'done', NOW(), $11, $12
       )
       ON CONFLICT (workspace_id, store_id, ebay_order_id, ebay_line_item_id) DO UPDATE SET
         sku = COALESCE(EXCLUDED.sku, sold_item_restock_events.sku),
         ebay_item_id = COALESCE(EXCLUDED.ebay_item_id, sold_item_restock_events.ebay_item_id),
         ebay_offer_id = COALESCE(EXCLUDED.ebay_offer_id, sold_item_restock_events.ebay_offer_id),
         catalog_state_id = COALESCE(EXCLUDED.catalog_state_id, sold_item_restock_events.catalog_state_id),
         checked_quantity = EXCLUDED.checked_quantity,
         action = EXCLUDED.action,
         status = 'done',
         checked_at = NOW(),
         restocked_at = EXCLUDED.restocked_at,
         error_message = EXCLUDED.error_message
       WHERE sold_item_restock_events.action IN (
         'failed', 'skipped_check_failed', 'skipped_no_catalog'
       )`,
      [
        input.workspaceId,
        input.storeId,
        input.ebayOrderId,
        input.ebayLineItemId,
        input.sku,
        input.ebayItemId,
        input.ebayOfferId,
        input.catalogStateId,
        input.checkedQuantity,
        input.action,
        input.restockedAt ?? null,
        input.errorMessage ?? null,
      ]
    )
    return (res.rowCount ?? 0) > 0
  } catch {
    return false
  }
}

/** Find catalog row for a sold line item (read-only). */
export async function findCatalogForSale(
  workspaceId: string,
  storeId:     number,
  catalogStateId: number | null,
  itemId:      string | null,
  sku:         string | null,
  title:       string | null
): Promise<CatalogListingRow | null> {
  if (catalogStateId) {
    const byId = await query<{
      id: number
      internal_sku: string | null
      ebay_item_id: string | null
      ebay_offer_id: string | null
      ebay_quantity: number | null
    }>(
      `SELECT id, internal_sku, ebay_item_id, ebay_offer_id, ebay_quantity
       FROM store_catalog_state
       WHERE workspace_id = $1::uuid
         AND store_id = $2
         AND id = $3::bigint
       LIMIT 1`,
      [workspaceId, storeId, catalogStateId]
    )
    const row = byId.rows[0]
    if (row) {
      return {
        catalogStateId: row.id,
        internalSku:    row.internal_sku?.trim() || null,
        ebayItemId:     row.ebay_item_id?.trim() || null,
        ebayOfferId:    row.ebay_offer_id?.trim() || null,
        ebayQuantity:   row.ebay_quantity,
      }
    }
  }

  if (!itemId && !sku && !title) return null

  const res = await query<{
    id: number
    internal_sku: string | null
    ebay_item_id: string | null
    ebay_offer_id: string | null
    ebay_quantity: number | null
  }>(
    `SELECT scs.id, scs.internal_sku, scs.ebay_item_id, scs.ebay_offer_id, scs.ebay_quantity
     FROM store_catalog_state scs
     WHERE scs.workspace_id = $1::uuid
       AND scs.store_id = $2
       AND (
         ($3::text IS NOT NULL AND trim(scs.ebay_item_id) = $3) OR
         ($4::text IS NOT NULL AND scs.internal_sku = $4) OR
         ($5::text IS NOT NULL AND lower(scs.ebay_title) = lower($5))
       )
     ORDER BY
       CASE
         WHEN $3::text IS NOT NULL AND trim(scs.ebay_item_id) = $3 THEN 1
         WHEN $4::text IS NOT NULL AND scs.internal_sku = $4 THEN 2
         WHEN $5::text IS NOT NULL AND lower(scs.ebay_title) = lower($5) THEN 3
         ELSE 9
       END
     LIMIT 1`,
    [workspaceId, storeId, itemId, sku, title]
  )

  const row = res.rows[0]
  if (!row) return null
  return {
    catalogStateId: row.id,
    internalSku:    row.internal_sku?.trim() || null,
    ebayItemId:     row.ebay_item_id?.trim() || null,
    ebayOfferId:    row.ebay_offer_id?.trim() || null,
    ebayQuantity:   row.ebay_quantity,
  }
}

export async function updateLocalCatalogQuantity(
  workspaceId:    string,
  storeId:        number,
  catalogStateId: number,
  quantity:       number
): Promise<void> {
  await query(
    `UPDATE store_catalog_state
     SET ebay_quantity = $4,
         updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND store_id = $2::bigint
       AND id = $3::bigint`,
    [workspaceId, storeId, catalogStateId, quantity]
  )
}
