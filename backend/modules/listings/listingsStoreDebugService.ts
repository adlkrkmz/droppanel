import { query } from "../../db/client"
import type { StoreListingsDebug } from "./listingsStoreDebugTypes"

type StoreRow = {
  id:         number
  name:       string
  store_code: string
}

export async function getStoreListingsDebug(
  workspaceId: string,
  storeCode:   string
): Promise<StoreListingsDebug> {
  const code = storeCode.trim()
  if (!code) throw new Error("storeCode is required")

  const storeRes = await query<StoreRow>(
    `SELECT id, name, store_code FROM stores
     WHERE workspace_id = $1 AND store_code = $2
     LIMIT 1`,
    [workspaceId, code]
  )
  const store = storeRes.rows[0]
  if (!store) throw new Error(`Store not found: ${code}`)

  const accountRes = await query<{
    ebay_user_id: string | null
    access_token: string | null
    refresh_token: string | null
    expires_at:   string | null
  }>(
    `SELECT ebay_user_id, access_token, refresh_token, expires_at::text AS expires_at
     FROM ebay_accounts
     WHERE workspace_id = $1 AND store_id = $2
     LIMIT 1`,
    [workspaceId, store.id]
  )
  const account = accountRes.rows[0]

  const statsRes = await query<{
    catalog_total:    string
    visible_count:    string
    hidden_count:     string
    ended_count:      string
    with_ebay_item:   string
    with_asin:        string
    last_sync_at:     string | null
  }>(
    `SELECT
       COUNT(*)::text AS catalog_total,
       COUNT(*) FILTER (WHERE panel_hidden_at IS NULL)::text AS visible_count,
       COUNT(*) FILTER (WHERE panel_hidden_at IS NOT NULL)::text AS hidden_count,
       COUNT(*) FILTER (WHERE current_status = 'ended')::text AS ended_count,
       COUNT(*) FILTER (
         WHERE ebay_item_id IS NOT NULL AND trim(ebay_item_id::text) <> ''
       )::text AS with_ebay_item,
       COUNT(*) FILTER (WHERE asin_registry_id IS NOT NULL)::text AS with_asin,
       MAX(last_sync_at)::text AS last_sync_at
     FROM store_catalog_state
     WHERE workspace_id = $1 AND store_id = $2`,
    [workspaceId, store.id]
  )
  const stats = statsRes.rows[0]

  const hasEbayAccount = !!(
    account?.access_token &&
    account?.refresh_token
  )

  return {
    storeCode:      store.store_code,
    storeId:        store.id,
    storeName:      store.name?.trim() || store.store_code,
    hasEbayAccount,
    ebayUserId:     account?.ebay_user_id?.trim() || null,
    tokenExpiresAt: account?.expires_at?.trim() || null,
    catalogTotal:   parseInt(stats?.catalog_total ?? "0", 10) || 0,
    visibleCount:   parseInt(stats?.visible_count ?? "0", 10) || 0,
    hiddenCount:    parseInt(stats?.hidden_count ?? "0", 10) || 0,
    endedCount:     parseInt(stats?.ended_count ?? "0", 10) || 0,
    withEbayItemId: parseInt(stats?.with_ebay_item ?? "0", 10) || 0,
    withAsin:       parseInt(stats?.with_asin ?? "0", 10) || 0,
    lastSyncAt:     stats?.last_sync_at?.trim() || null,
  }
}
