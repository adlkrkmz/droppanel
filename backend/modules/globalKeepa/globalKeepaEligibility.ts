/**
 * Active unique ASIN eligibility for the V2 global Keepa planner.
 *
 * Routine Keepa tokens are spent only for listings that can still receive orders:
 * live, Stock Guard on, qty > 0, valid consumer/ASIN. Hide is panel visibility only.
 * qty = 0 (manual, approved, or bot-zeroed) is never selected.
 *
 * Intentionally omits source_next_check_at — that is the legacy scheduler gate.
 * When V2 owns automated scanning, legacy scheduler is gated separately.
 */
export const GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE = `
  COALESCE(scs.stock_guard_enabled, true) = true
  AND (scs.current_status IS NULL OR scs.current_status = 'live')
  AND scs.ebay_item_id IS NOT NULL
  AND BTRIM(scs.ebay_item_id) <> ''
  AND st.status = 'active'
  AND scs.workspace_id = c.workspace_id
  AND scs.store_id = c.store_id
  AND COALESCE(scs.ebay_quantity, 0) > 0
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

export const GLOBAL_KEEPA_ACTIVE_PRIORITY_SQL = `
  MIN(
    CASE
      WHEN COALESCE(scs.total_sold, 0) > 0 OR COALESCE(scs.sold_30d, 0) > 0 THEN 0
      WHEN COALESCE(scs.clicks_30d, 0) > 0 THEN 1
      ELSE 2
    END
  )
`

export const GLOBAL_KEEPA_ACTIVE_ASINS_SQL = `
SELECT g.id AS global_asin_id,
       g.keepa_domain,
       g.asin,
       ${GLOBAL_KEEPA_ACTIVE_PRIORITY_SQL} AS priority,
       p.last_checked_at,
       p.next_check_at,
       COUNT(*)::int AS consumer_count
FROM global_asin_consumers c
JOIN global_amazon_asins g ON g.id = c.global_asin_id
JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
LEFT JOIN global_keepa_planner_state p ON p.global_asin_id = g.id
WHERE ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE}
GROUP BY g.id, g.keepa_domain, g.asin, p.last_checked_at, p.next_check_at
`

export const GLOBAL_KEEPA_ACTIVE_ASIN_IDS_SQL = `
SELECT DISTINCT c.global_asin_id
FROM global_asin_consumers c
JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
WHERE ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE}
`
