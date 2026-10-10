import { query } from "../../db/client"
import { loadGlobalKeepaFoundationConfig } from "../globalKeepa/globalKeepaConfig"
import { minRecheckHoursForPriority } from "../globalKeepa/globalKeepaCapacity"
import type { ListingPriorityRank } from "../globalKeepa/globalKeepaTypes"
import type { DesktopAgentAsinItem } from "./desktopAgentTypes"

/**
 * Workspace-scoped Desktop Agent ASIN eligibility.
 * Same Stock Guard / live / active-store gates as Keepa active set,
 * but intentionally DOES NOT require ebay_quantity > 0 (qty=0 still scannable).
 */
export const DESKTOP_AGENT_LISTING_WHERE = `
  COALESCE(scs.stock_guard_enabled, true) = true
  AND (scs.current_status IS NULL OR scs.current_status = 'live')
  AND scs.ebay_item_id IS NOT NULL
  AND BTRIM(scs.ebay_item_id) <> ''
  AND st.status = 'active'
  AND (
    EXISTS (
      SELECT 1 FROM asin_registry ar
      WHERE ar.id = scs.asin_registry_id
        AND ar.workspace_id = scs.workspace_id
        AND ar.asin ~ '^[A-Z0-9]{10}$'
    )
    OR scs.source_url ~* 'amazon\\.com/(dp|gp/product)/[A-Z0-9]{10}'
    OR BTRIM(COALESCE(scs.internal_sku, '')) ~ '^[A-Z0-9]{10}$'
    OR COALESCE(scs.internal_sku, '') ~ '^DP-[A-Z0-9]{10}-'
    OR COALESCE(scs.internal_sku, '') ~ '^DP[A-Z0-9]{10}[A-Z0-9]{1,4}$'
  )
`

const RESOLVED_ASIN_SQL = `
  UPPER(COALESCE(
    (
      SELECT ar.asin FROM asin_registry ar
      WHERE ar.id = scs.asin_registry_id
        AND ar.workspace_id = scs.workspace_id
        AND ar.asin ~ '^[A-Z0-9]{10}$'
      LIMIT 1
    ),
    SUBSTRING(UPPER(COALESCE(scs.source_url, '')) FROM 'AMAZON\\.COM/(?:DP|GP/PRODUCT)/([A-Z0-9]{10})'),
    CASE
      WHEN BTRIM(COALESCE(scs.internal_sku, '')) ~ '^[A-Z0-9]{10}$'
      THEN BTRIM(scs.internal_sku)
      ELSE NULL
    END,
    SUBSTRING(UPPER(COALESCE(scs.internal_sku, '')) FROM '^DP-([A-Z0-9]{10})-'),
    SUBSTRING(UPPER(COALESCE(scs.internal_sku, '')) FROM '^DP([A-Z0-9]{10})[A-Z0-9]{1,4}$')
  ))
`

const LISTING_PRIORITY_SQL = `
  CASE
    WHEN COALESCE(scs.total_sold, 0) > 0 OR COALESCE(scs.sold_30d, 0) > 0 THEN 0
    WHEN COALESCE(scs.clicks_30d, 0) > 0 THEN 1
    ELSE 2
  END
`

export type DesktopAgentListingMatch = {
  catalogStateId: number
  storeId: number
  asin: string
  globalAsinId: number | null
  priority: ListingPriorityRank
  totalSold: number
  sold30d: number
  clicks30d: number
}

export async function listDesktopAgentAsins(workspaceId: string): Promise<DesktopAgentAsinItem[]> {
  const cfg = loadGlobalKeepaFoundationConfig()
  const res = await query<{
    asin: string
    global_asin_id: string | null
    priority: string
    listing_count: string
    next_check_at: Date | string | null
  }>(
    `WITH eligible AS (
       SELECT
         ${RESOLVED_ASIN_SQL} AS asin,
         ${LISTING_PRIORITY_SQL} AS priority,
         g.id AS global_asin_id,
         p.next_check_at
       FROM store_catalog_state scs
       JOIN stores st ON st.id = scs.store_id AND st.workspace_id = scs.workspace_id
       LEFT JOIN global_amazon_asins g
         ON g.asin = ${RESOLVED_ASIN_SQL}
        AND g.keepa_domain = $2::integer
       LEFT JOIN global_keepa_planner_state p ON p.global_asin_id = g.id
       WHERE scs.workspace_id = $1::uuid
         AND ${DESKTOP_AGENT_LISTING_WHERE}
     )
     SELECT asin,
            MIN(global_asin_id)::text AS global_asin_id,
            MIN(priority)::text AS priority,
            COUNT(*)::text AS listing_count,
            MIN(next_check_at) AS next_check_at
     FROM eligible
     WHERE asin IS NOT NULL
       AND asin ~ '^[A-Z0-9]{10}$'
     GROUP BY asin
     ORDER BY MIN(priority) ASC, asin ASC`,
    [workspaceId, cfg.keepaDomain]
  )

  return res.rows.map(row => {
    const priority = (Number(row.priority) === 0 || Number(row.priority) === 1
      ? Number(row.priority)
      : 2) as ListingPriorityRank
    return {
      asin: row.asin,
      globalAsinId: row.global_asin_id != null ? Number(row.global_asin_id) : null,
      priority,
      cadenceHours: minRecheckHoursForPriority(priority, cfg),
      nextCheckAt: row.next_check_at ? new Date(row.next_check_at).toISOString() : null,
      listingCount: Number(row.listing_count) || 0,
    }
  })
}

/** Best matching live listing for ASIN inside one workspace (qty may be 0). */
export async function findDesktopAgentListingForAsin(input: {
  workspaceId: string
  asin: string
}): Promise<DesktopAgentListingMatch | null> {
  const asin = input.asin.trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) return null
  const cfg = loadGlobalKeepaFoundationConfig()
  const res = await query<{
    catalog_state_id: string
    store_id: string
    asin: string
    global_asin_id: string | null
    priority: string
    total_sold: string | null
    sold_30d: string | null
    clicks_30d: string | null
  }>(
    `SELECT scs.id::text AS catalog_state_id,
            scs.store_id::text AS store_id,
            ${RESOLVED_ASIN_SQL} AS asin,
            g.id::text AS global_asin_id,
            (${LISTING_PRIORITY_SQL})::text AS priority,
            COALESCE(scs.total_sold, 0)::text AS total_sold,
            COALESCE(scs.sold_30d, 0)::text AS sold_30d,
            COALESCE(scs.clicks_30d, 0)::text AS clicks_30d
     FROM store_catalog_state scs
     JOIN stores st ON st.id = scs.store_id AND st.workspace_id = scs.workspace_id
     LEFT JOIN global_amazon_asins g
       ON g.asin = ${RESOLVED_ASIN_SQL}
      AND g.keepa_domain = $3::integer
     WHERE scs.workspace_id = $1::uuid
       AND ${DESKTOP_AGENT_LISTING_WHERE}
       AND ${RESOLVED_ASIN_SQL} = $2
     ORDER BY (${LISTING_PRIORITY_SQL}) ASC, scs.id ASC
     LIMIT 1`,
    [input.workspaceId, asin, cfg.keepaDomain]
  )
  const row = res.rows[0]
  if (!row) return null
  const priority = (Number(row.priority) === 0 || Number(row.priority) === 1
    ? Number(row.priority)
    : 2) as ListingPriorityRank
  return {
    catalogStateId: Number(row.catalog_state_id),
    storeId: Number(row.store_id),
    asin: row.asin,
    globalAsinId: row.global_asin_id != null ? Number(row.global_asin_id) : null,
    priority,
    totalSold: Number(row.total_sold) || 0,
    sold30d: Number(row.sold_30d) || 0,
    clicks30d: Number(row.clicks_30d) || 0,
  }
}

export async function ensureDesktopAgentGlobalAsin(asin: string, priority: ListingPriorityRank): Promise<number> {
  const cfg = loadGlobalKeepaFoundationConfig()
  const normalized = asin.trim().toUpperCase()
  const res = await query<{ id: string }>(
    `INSERT INTO global_amazon_asins (keepa_domain, asin, priority, is_active, created_at, updated_at)
     VALUES ($1::integer, $2::text, $3::smallint, TRUE, NOW(), NOW())
     ON CONFLICT (keepa_domain, asin) DO UPDATE SET
       priority = LEAST(COALESCE(global_amazon_asins.priority, EXCLUDED.priority), EXCLUDED.priority),
       updated_at = NOW()
     RETURNING id`,
    [cfg.keepaDomain, normalized, priority]
  )
  return Number(res.rows[0].id)
}
