import { query } from "../../db/client"
import { GLOBAL_KEEPA_ACTIVE_PRIORITY_SQL } from "../globalKeepa/globalKeepaEligibility"
import { amazonScanRecheckHours, loadAmazonScanConfig, plannerRoutineEnqueueBudget } from "./amazonScanConfig"
import { scanSpreadSeconds } from "./amazonScanKey"
import { enqueueScanJob } from "./amazonScanJobQueue"

/**
 * Scan pool: live + Stock Guard on + active store + valid ASIN.
 * Qty=0 (bot/manual zero) stays attached so restock can still be observed.
 * Keepa routine eligibility still requires qty>0 — do not reuse this for Keepa tokens.
 */
export const AMAZON_SCAN_ACTIVE_CONSUMER_WHERE = `
  COALESCE(scs.stock_guard_enabled, true) = true
  AND (scs.current_status IS NULL OR scs.current_status = 'live')
  AND scs.ebay_item_id IS NOT NULL
  AND BTRIM(scs.ebay_item_id) <> ''
  AND st.status = 'active'
  AND scs.workspace_id = c.workspace_id
  AND scs.store_id = c.store_id
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

const AMAZON_SCAN_ACTIVE_ASINS_SQL = `
SELECT g.id AS global_asin_id,
       g.asin,
       ${GLOBAL_KEEPA_ACTIVE_PRIORITY_SQL} AS priority
FROM global_asin_consumers c
JOIN global_amazon_asins g ON g.id = c.global_asin_id
JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
WHERE ${AMAZON_SCAN_ACTIVE_CONSUMER_WHERE}
GROUP BY g.id, g.asin
`

let timer: NodeJS.Timeout | null = null
let tickInProgress = false

export async function syncAmazonScanCadenceFromActiveConsumers(): Promise<number> {
  const cfg = loadAmazonScanConfig()
  const res = await query(
    `INSERT INTO amazon_scan_cadence (
       global_asin_id, scan_key, asin, marketplace, delivery_zip, session_class,
       priority, next_check_at, created_at, updated_at
     )
     SELECT g.id,
            upper(g.asin) || '|' || $1 || '|' || $2 || '|' || $3,
            g.asin,
            $1, $2, $3,
            active.priority,
            NOW() + make_interval(secs => (abs(('x' || substr(md5(g.asin), 1, 8))::bit(32)::int) % 900)),
            NOW(), NOW()
     FROM (${AMAZON_SCAN_ACTIVE_ASINS_SQL}) active
     JOIN global_amazon_asins g ON g.id = active.global_asin_id
     ON CONFLICT (global_asin_id) DO UPDATE SET
       priority = EXCLUDED.priority,
       scan_key = EXCLUDED.scan_key,
       asin = EXCLUDED.asin,
       marketplace = EXCLUDED.marketplace,
       delivery_zip = EXCLUDED.delivery_zip,
       session_class = EXCLUDED.session_class,
       updated_at = NOW()`,
    [cfg.marketplace, cfg.deliveryZip, cfg.sessionClass]
  )
  return res.rowCount ?? 0
}

/** Detach consumers only for confirmed ineligible listings, not missing rows or qty=0. */
export async function pruneIneligibleAsinConsumers(): Promise<number> {
  const res = await query(
    `DELETE FROM global_asin_consumers c
     WHERE EXISTS (
       SELECT 1
       FROM store_catalog_state scs
       JOIN stores st ON st.id = scs.store_id AND st.workspace_id = scs.workspace_id
       WHERE scs.id = c.catalog_state_id
         AND scs.workspace_id = c.workspace_id
         AND scs.store_id = c.store_id
         AND (
           st.status <> 'active'
           OR scs.stock_guard_enabled = false
           OR lower(COALESCE(scs.current_status::text, 'live')) IN ('ended', 'completed', 'deleted')
         )
     )`
  )
  return res.rowCount ?? 0
}

export async function runAmazonBrowserPlannerTick(): Promise<{
  skipped?: string
  synced: number
  pruned: number
  enqueued: number
  activeRoutine: number
  enqueueBudget: number
}> {
  const cfg = loadAmazonScanConfig()
  if (!cfg.plannerEnabled) {
    return { skipped: "PLANNER_DISABLED", synced: 0, pruned: 0, enqueued: 0, activeRoutine: 0, enqueueBudget: 0 }
  }

  const synced = await syncAmazonScanCadenceFromActiveConsumers()
  const pruned = await pruneIneligibleAsinConsumers()

  const activeRes = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM amazon_scan_jobs
     WHERE kind = 'ROUTINE'
       AND status IN ('PENDING', 'RETRYABLE', 'CLAIMED', 'RUNNING')`
  )
  const activeRoutine = parseInt(activeRes.rows[0]?.c ?? "0", 10) || 0
  const enqueueBudget = plannerRoutineEnqueueBudget({
    activeRoutineCount: activeRoutine,
    batchSize: cfg.plannerBatchSize,
    maxOutstanding: cfg.plannerMaxOutstanding,
  })
  if (enqueueBudget <= 0) {
    return { synced, pruned, enqueued: 0, activeRoutine, enqueueBudget }
  }

  const due = await query<{
    global_asin_id: string
    asin: string
    priority: number
    last_success_at: Date | null
  }>(
    `SELECT c.global_asin_id::text, c.asin, c.priority, c.last_success_at
     FROM amazon_scan_cadence c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     WHERE (c.next_check_at IS NULL OR c.next_check_at <= NOW())
       AND EXISTS (
         SELECT 1 FROM (${AMAZON_SCAN_ACTIVE_ASINS_SQL}) active
         WHERE active.global_asin_id = c.global_asin_id
       )
     ORDER BY c.next_check_at ASC NULLS FIRST, c.priority ASC, c.global_asin_id ASC
     LIMIT $1`,
    [enqueueBudget]
  )

  let enqueued = 0
  for (const row of due.rows) {
    if (enqueued >= enqueueBudget) break
    const priority = Number(row.priority) || 2
    const hours = amazonScanRecheckHours(priority, cfg)
    if (row.last_success_at) {
      const ageH = (Date.now() - new Date(row.last_success_at).getTime()) / 3600_000
      if (ageH < hours) {
        const spread = scanSpreadSeconds(row.asin, Math.min(3600 * hours, 6 * 3600))
        await query(
          `UPDATE amazon_scan_cadence
           SET next_check_at = last_success_at + make_interval(hours => $2::int) + make_interval(secs => $3::int),
               updated_at = NOW()
           WHERE global_asin_id = $1::bigint`,
          [row.global_asin_id, hours, spread]
        )
        continue
      }
    }
    const made = await enqueueScanJob({
      globalAsinId: Number(row.global_asin_id),
      asin: row.asin,
      marketplace: cfg.marketplace,
      deliveryZip: cfg.deliveryZip,
      sessionClass: cfg.sessionClass,
      kind: "ROUTINE",
      priority,
    })
    if (made.created) enqueued++
    const spread = scanSpreadSeconds(row.asin, Math.min(3600 * hours, 6 * 3600))
    await query(
      `UPDATE amazon_scan_cadence
       SET next_check_at = NOW() + make_interval(hours => $2::int) + make_interval(secs => $3::int),
           updated_at = NOW()
       WHERE global_asin_id = $1::bigint`,
      [row.global_asin_id, hours, spread]
    )
  }
  return { synced, pruned, enqueued, activeRoutine, enqueueBudget }
}

/** Successful observe advances cadence; failures must not call this. */
export async function markScanCadenceSuccess(globalAsinId: number, checkedAt = new Date()): Promise<void> {
  const cfg = loadAmazonScanConfig()
  const row = await query<{ asin: string; priority: number }>(
    `SELECT asin, priority FROM amazon_scan_cadence WHERE global_asin_id = $1::bigint`,
    [globalAsinId]
  )
  const asin = row.rows[0]?.asin
  const priority = Number(row.rows[0]?.priority) || 2
  if (!asin) return
  const hours = amazonScanRecheckHours(priority, cfg)
  const spread = scanSpreadSeconds(asin, Math.min(3600 * hours, 6 * 3600))
  await query(
    `UPDATE amazon_scan_cadence
     SET last_success_at = $2::timestamptz,
         last_checked_at = $2::timestamptz,
         failure_count = 0,
         next_check_at = $2::timestamptz + make_interval(hours => $3::int) + make_interval(secs => $4::int),
         updated_at = NOW()
     WHERE global_asin_id = $1::bigint`,
    [globalAsinId, checkedAt, hours, spread]
  )
}

export async function markScanCadenceFailure(globalAsinId: number): Promise<void> {
  await query(
    `UPDATE amazon_scan_cadence
     SET last_checked_at = NOW(),
         failure_count = failure_count + 1,
         updated_at = NOW()
     WHERE global_asin_id = $1::bigint`,
    [globalAsinId]
  )
}

export function startAmazonBrowserPlannerScheduler(): void {
  const cfg = loadAmazonScanConfig()
  if (!cfg.plannerEnabled) {
    console.log("[AmazonScanPlanner] disabled (AMAZON_BROWSER_PLANNER_ENABLED=false)")
    return
  }
  if (timer) return
  const tick = (): void => {
    if (tickInProgress) return
    tickInProgress = true
    void runAmazonBrowserPlannerTick()
      .then(r => console.log("[AmazonScanPlanner] tick", r))
      .catch(e => console.error("[AmazonScanPlanner] tick failed:", e instanceof Error ? e.message : e))
      .finally(() => {
        tickInProgress = false
      })
  }
  timer = setInterval(tick, cfg.tickIntervalMs)
  console.log(`[AmazonScanPlanner] started intervalMs=${cfg.tickIntervalMs}`)
}
