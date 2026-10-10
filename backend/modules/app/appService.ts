// ----------------------------------------------------------------
// appService.ts — user-scoped read services for dashboard & stores
// ----------------------------------------------------------------

import { query, queryWithoutJit } from "../../db/client"
import type {
  AppDashboardResponse,
  AppOnboardingStatus,
  AppStoreSummary,
  AppStoresResponse,
} from "./appTypes"
import { LISTING_HAS_ASIN_SQL } from "./appListingFilters"
import { STOCK_ALERTS_VISIBLE_SQL } from "../stockAlerts/stockAlertListQuery"
import { accountHasMarketingScope, toMarketingAccess } from "../ebayOAuth/ebayOAuthService"

export async function getAppStores(workspaceId: string): Promise<AppStoresResponse> {
  const res = await query<{
    id: number
    store_code: string
    name: string
    status: string
    has_ebay: boolean
    ebay_expires_at: string | null
    listing_count: string
    asin_linked_count: string
    alerts_count: string
    ebay_scope: string | null
  }>(
    `SELECT
       s.id,
       s.store_code,
       s.name,
       s.status,
       EXISTS (
         SELECT 1 FROM ebay_accounts ea
         WHERE ea.store_id = s.id AND ea.workspace_id = s.workspace_id
           AND ea.access_token IS NOT NULL
           AND ea.refresh_token IS NOT NULL
       ) AS has_ebay,
       (
         SELECT ea.expires_at::text
         FROM ebay_accounts ea
         WHERE ea.store_id = s.id AND ea.workspace_id = s.workspace_id
         LIMIT 1
       ) AS ebay_expires_at,
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
         LEFT JOIN asin_registry ar
           ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
         WHERE scs.store_id = s.id
           AND scs.workspace_id = s.workspace_id
           AND scs.panel_hidden_at IS NULL
           AND ${LISTING_HAS_ASIN_SQL}
       ) AS asin_linked_count,
       (
         SELECT COUNT(*)::text
         FROM stock_review_items sri
         WHERE sri.store_id = s.id
           AND sri.workspace_id = s.workspace_id
           AND sri.review_status = 'pending'
           AND ${STOCK_ALERTS_VISIBLE_SQL}
       ) AS alerts_count,
       (
         SELECT ea.scope
         FROM ebay_accounts ea
         WHERE ea.store_id = s.id AND ea.workspace_id = s.workspace_id
         LIMIT 1
       ) AS ebay_scope
     FROM stores s
     WHERE s.workspace_id = $1::uuid
       AND s.status = 'active'
     ORDER BY s.created_at ASC`,
    [workspaceId]
  )

  const stores: AppStoreSummary[] = res.rows.map(r => {
    const listingCount     = parseInt(r.listing_count ?? "0", 10) || 0
    const asinLinkedCount  = parseInt(r.asin_linked_count ?? "0", 10) || 0
    const needsAsinCount   = listingCount > 0 ? Math.max(0, listingCount - asinLinkedCount) : 0
    const asinCompletionPercent =
      listingCount > 0 ? Math.round((asinLinkedCount / listingCount) * 100) : 0
    const connected = r.has_ebay === true
    const expiresAt = r.ebay_expires_at?.trim() || null
    const expired =
      expiresAt != null && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) < Date.now()

    let connectionHint: AppStoreSummary["connectionHint"] = "connected"
    if (!connected) connectionHint = "reconnect_suggested"
    else if (expired) connectionHint = "reconnect_suggested"

    return {
      storeId:               r.id,
      storeCode:             r.store_code,
      name:                  r.name,
      status:                r.status,
      connected,
      connectionHint,
      ebayExpiresAt:         expiresAt,
      listingCount,
      stockAlertsCount:      parseInt(r.alerts_count ?? "0", 10) || 0,
      asinLinkedCount,
      needsAsinCount,
      asinCompletionPercent,
      hasMarketingScope:    accountHasMarketingScope(r.ebay_scope),
      marketingAccess:      toMarketingAccess(r.ebay_scope),
    }
  })

  return { ok: true, stores }
}

export async function getAppDashboard(workspaceId: string): Promise<AppDashboardResponse> {
  const statsRes = await queryWithoutJit<{
    store_count: string
    connected_count: string
    listing_count: string
    active_listing_count: string
    pending_alerts: string
    last_import_at: string | null
    stores_with_settings: string
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM stores
        WHERE workspace_id = $1::uuid AND status = 'active') AS store_count,
       (SELECT COUNT(*)::text FROM stores s
        INNER JOIN ebay_accounts ea ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id
        WHERE s.workspace_id = $1::uuid AND s.status = 'active') AS connected_count,
       (SELECT COUNT(*)::text FROM store_catalog_state
        WHERE workspace_id = $1::uuid AND panel_hidden_at IS NULL) AS listing_count,
       (SELECT COUNT(*)::text FROM store_catalog_state
        WHERE workspace_id = $1::uuid
          AND panel_hidden_at IS NULL
          AND current_status = 'live') AS active_listing_count,
       (SELECT COUNT(*)::text FROM stock_review_items sri
        WHERE workspace_id = $1::uuid
          AND review_status = 'pending'
          AND ${STOCK_ALERTS_VISIBLE_SQL}) AS pending_alerts,
       (SELECT MAX(created_at)::text FROM import_batches
        WHERE workspace_id = $1::uuid) AS last_import_at,
       (SELECT COUNT(DISTINCT ss.store_id)::text
        FROM store_settings ss
        INNER JOIN stores s ON s.id = ss.store_id
        WHERE ss.workspace_id = $1::uuid
          AND s.status = 'active'
          AND ss.address_line1 IS NOT NULL
          AND trim(ss.address_line1) <> '') AS stores_with_settings`,
    [workspaceId]
  )

  const row = statsRes.rows[0]
  const parse = (v: string | undefined): number => parseInt(v ?? "0", 10) || 0

  const storeCount         = parse(row?.store_count)
  const connectedStoreCount = parse(row?.connected_count)
  const listingCount       = parse(row?.listing_count)
  const activeListingCount = parse(row?.active_listing_count)
  const pendingStockAlerts = parse(row?.pending_alerts)
  const storesWithSettings = parse(row?.stores_with_settings)

  const asinRes = await queryWithoutJit<{ asin_linked: string }>(
    `SELECT COUNT(*)::text AS asin_linked
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND scs.panel_hidden_at IS NULL
       AND ${LISTING_HAS_ASIN_SQL}`,
    [workspaceId]
  )

  const asinLinkedCount = parse(asinRes.rows[0]?.asin_linked)
  const needsAsinCount  = listingCount > 0 ? Math.max(0, listingCount - asinLinkedCount) : 0
  const asinCompletionPercent =
    listingCount > 0 ? Math.round((asinLinkedCount / listingCount) * 100) : 0

  const onboarding: AppOnboardingStatus = {
    needsEbayConnect: connectedStoreCount === 0,
    needsImport:      connectedStoreCount > 0 && listingCount === 0,
    needsSettings:    connectedStoreCount > 0 && storesWithSettings < connectedStoreCount,
  }

  return {
    ok: true,
    summary: {
      storeCount,
      connectedStoreCount,
      listingCount,
      activeListingCount,
      pendingStockAlerts,
      lastImportAt: row?.last_import_at ?? null,
      asinLinkedCount,
      needsAsinCount,
      asinCompletionPercent,
    },
    onboarding,
  }
}
