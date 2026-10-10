// ----------------------------------------------------------------
// appImportStatusService.ts — user-scoped import/sync status (Phase 3I-D)
// ----------------------------------------------------------------

import { query } from "../../db/client"
import type { AppImportStatusResponse } from "./appTypes"
import type { OwnedStore } from "./appOwnership"
import { STOCK_ALERTS_VISIBLE_SQL } from "../stockAlerts/stockAlertListQuery"

export async function getAppImportStatus(input: {
  workspaceId: string
  store:       OwnedStore
}): Promise<AppImportStatusResponse> {
  const res = await query<{
    store_code:            string
    sync_status:           string | null
    last_catalog_sync_at:  string | null
    sync_error:            string | null
    updated_at:            string | null
    listing_count:         string
    active_listing_count:  string
    pending_alerts:        string
  }>(
    `SELECT
       s.store_code,
       s.sync_status,
       s.last_catalog_sync_at::text,
       s.sync_error,
       s.updated_at::text,
       (
         SELECT COUNT(*)::text
         FROM store_catalog_state scs
         WHERE scs.store_id = s.id
           AND scs.workspace_id = s.workspace_id
           AND scs.panel_hidden_at IS NULL
       ) AS listing_count,
       (
         SELECT COUNT(*)::text
         FROM store_catalog_state scs
         WHERE scs.store_id = s.id
           AND scs.workspace_id = s.workspace_id
           AND scs.panel_hidden_at IS NULL
           AND scs.current_status = 'live'
       ) AS active_listing_count,
       (
         SELECT COUNT(*)::text
         FROM stock_review_items sri
         WHERE sri.store_id = s.id
           AND sri.workspace_id = s.workspace_id
           AND sri.review_status = 'pending'
           AND ${STOCK_ALERTS_VISIBLE_SQL}
       ) AS pending_alerts
     FROM stores s
     WHERE s.id = $1
       AND s.workspace_id = $2::uuid
     LIMIT 1`,
    [input.store.id, input.workspaceId]
  )

  const row = res.rows[0]
  if (!row) {
    throw new Error("Store not found")
  }

  const parseCount = (v: string | undefined): number => parseInt(v ?? "0", 10) || 0

  return {
    ok:                 true,
    storeId:            input.store.id,
    storeCode:          row.store_code,
    syncStatus:         row.sync_status?.trim() || null,
    lastCatalogSyncAt:  row.last_catalog_sync_at?.trim() || null,
    syncStartedAt:      null,
    syncError:          row.sync_error?.trim() || null,
    listingCount:       parseCount(row.listing_count),
    activeListingCount: parseCount(row.active_listing_count),
    pendingAlerts:      parseCount(row.pending_alerts),
    updatedAt:          row.updated_at?.trim() || null,
  }
}
