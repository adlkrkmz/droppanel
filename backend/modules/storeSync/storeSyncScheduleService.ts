import { query } from "../../db/client"

import { sync30dClicksForStore } from "../listings/listingsSync30dClicksService"
import type { Sync30dClicksResponse } from "../listings/listingsSync30dClicksTypes"

import { syncListingMetrics } from "../listings/listingsMetricsService"

import { accountHasAnalyticsScope } from "../ebayOAuth/ebayOAuthService"



/** Catalog inventory pull cadence — keep short so new eBay listings appear in /app/listings quickly. */
const CATALOG_INTERVAL_HOURS = 6

const METRICS_INTERVAL_DAYS = 2

const CLICKS_30D_INTERVAL_HOURS = 24

const ERROR_RETRY_HOURS       = 6

const CLICKS_ERROR_RETRY_HOURS = 2

const CLICKS_STALE_RUNNING_MIN = 30

/** Large catalogs (4k+) can run 30–60+ min; recover only clearly stuck ownership. */
const CATALOG_STALE_RUNNING_MIN = 90

const MAIN_TICK_MS            = 5 * 60 * 1000

const CLICKS_DUE_CHECK_MS     = 15 * 60 * 1000



type DueJob = {

  workspaceId: string

  storeCode:   string

  storeId:     number

  jobType:     "catalog" | "metrics" | "clicks_30d"

}



let processing = false

let schedulerStarted = false



function catalogIntervalSql(): string {

  return `NOW() + interval '${CATALOG_INTERVAL_HOURS} hours'`

}



function metricsIntervalSql(): string {

  return `NOW() + interval '${METRICS_INTERVAL_DAYS} days'`

}



function clicks30dIntervalSql(): string {

  return `NOW() + interval '${CLICKS_30D_INTERVAL_HOURS} hours'`

}



function errorRetrySql(): string {

  return `NOW() + interval '${ERROR_RETRY_HOURS} hours'`

}



function clicksErrorRetrySql(): string {

  return `NOW() + interval '${CLICKS_ERROR_RETRY_HOURS} hours'`

}



/** Queue immediate catalog sync (store connect / manual refresh). */

export async function scheduleCatalogSyncImmediate(

  workspaceId: string,

  storeCode:   string

): Promise<void> {

  try {

    const existing = await query<{ id: number; sync_status: string | null }>(

      `SELECT id, sync_status FROM stores

       WHERE workspace_id = $1 AND store_code = $2 AND status = 'active'

       ORDER BY id ASC

       LIMIT 1`,

      [workspaceId, storeCode.trim()]

    )

    const row = existing.rows[0]

    if (!row) return

    const status = row.sync_status?.trim() || null

    if (status === "catalog_running" || status === "pending") {

      console.log(

        `[StoreSyncSchedule] Catalog sync already queued/running store=${storeCode} store_id=${row.id} status=${status}`

      )

      requestStoreSyncQueueTick()

      return

    }

    await query(

      `UPDATE stores

       SET next_catalog_sync_at = NOW(),

           sync_status = 'pending',

           sync_error = NULL,

           updated_at = NOW()

       WHERE id = $1 AND status = 'active'

         AND COALESCE(sync_status, '') NOT IN ('catalog_running', 'pending')`,

      [row.id]

    )

    console.log(`[StoreSyncSchedule] Catalog sync queued store=${storeCode} store_id=${row.id}`)

    requestStoreSyncQueueTick()

  } catch (e) {

    console.warn(

      `[StoreSyncSchedule] Could not queue catalog sync for ${storeCode} — run migration 023?`,

      e instanceof Error ? e.message : e

    )

  }

}



/**

 * Canonical: queue catalog sync by exact store_id + workspace ownership.

 * Avoids storeCode ambiguity. Idempotent; skips re-queue while catalog_running.

 */

export async function scheduleCatalogSyncImmediateByStoreId(

  workspaceId: string,

  storeId:     number

): Promise<{ queued: boolean; syncStatus: string | null }> {

  if (!Number.isInteger(storeId) || storeId < 1) {

    throw new Error("storeId is required")

  }



  const existing = await query<{ sync_status: string | null }>(

    `SELECT sync_status FROM stores

     WHERE workspace_id = $1::uuid AND id = $2 AND status = 'active'

     LIMIT 1`,

    [workspaceId, storeId]

  )

  const row = existing.rows[0]

  if (!row) throw new Error("Active store not found")



  const status = row.sync_status?.trim() || null

  if (status === "catalog_running" || status === "pending") {

    console.log(

      `[StoreSyncSchedule] Catalog sync already queued/running store_id=${storeId} status=${status}`

    )

    requestStoreSyncQueueTick()

    return { queued: false, syncStatus: status }

  }



  await query(

    `UPDATE stores

     SET next_catalog_sync_at = NOW(),

         sync_status = 'pending',

         sync_error = NULL,

         updated_at = NOW()

     WHERE workspace_id = $1::uuid AND id = $2 AND status = 'active'

       AND COALESCE(sync_status, '') NOT IN ('catalog_running', 'pending')`,

    [workspaceId, storeId]

  )

  console.log(`[StoreSyncSchedule] Catalog sync queued store_id=${storeId}`)

  requestStoreSyncQueueTick()

  return { queued: true, syncStatus: "pending" }

}



/** Queue 30D clicks sync soon for exact store_id (after catalog bootstrap). */

export async function scheduleClicks30dSyncSoonByStoreId(

  workspaceId: string,

  storeId:     number,

  delayMinutes = 2

): Promise<void> {

  if (!Number.isInteger(storeId) || storeId < 1) return

  const delay = Math.max(0, Math.min(60, Math.trunc(delayMinutes)))

  try {

    await query(

      `UPDATE stores

       SET clicks_30d_next_sync_at = NOW() + ($3::int * interval '1 minute'),

           updated_at = NOW()

       WHERE workspace_id = $1::uuid

         AND id = $2

         AND status = 'active'

         AND COALESCE(clicks_30d_sync_status, '') <> 'running'`,

      [workspaceId, storeId, delay]

    )

    console.log(

      `[StoreSyncSchedule] 30D clicks sync queued store_id=${storeId} in ${delay}m`

    )

    requestStoreSyncQueueTick()

  } catch (e) {

    console.warn(

      `[StoreSyncSchedule] Could not queue 30D clicks for store_id=${storeId}:`,

      e instanceof Error ? e.message : e

    )

  }

}



/**

 * New-store OAuth bootstrap: catalog (listings+Sold), traffic, and initial 30d orders.

 * Non-blocking — schedules/fires background work only.

 */

export async function scheduleNewStoreDataBootstrap(input: {

  workspaceId: string

  storeId:     number

  storeCode:   string

  storeName:   string

}): Promise<void> {

  const { workspaceId, storeId, storeCode, storeName } = input

  await scheduleCatalogSyncImmediateByStoreId(workspaceId, storeId)

  await scheduleClicks30dSyncSoonByStoreId(workspaceId, storeId, 2)



  void (async () => {

    try {

      const { syncOrdersForStore } = await import("../orders/ordersSyncService")

      const outcome = await syncOrdersForStore(workspaceId, {

        id:        storeId,

        storeCode,

        name:      storeName,

      })

      if (outcome.error) {

        console.warn(

          `[StoreSyncSchedule] Orders bootstrap failed store_id=${storeId}:`,

          outcome.error.message

        )

      } else {

        console.log(

          `[StoreSyncSchedule] Orders bootstrap done store_id=${storeId} fetched=${outcome.result?.fetched ?? 0}`

        )

      }

    } catch (e) {

      console.warn(

        `[StoreSyncSchedule] Orders bootstrap error store_id=${storeId}:`,

        e instanceof Error ? e.message : e

      )

    }

  })()

}



/** Stagger first-time sync for connected stores without a schedule. */

export async function initializeStoreSyncSchedule(): Promise<void> {

  try {

    await query(

      `UPDATE stores s

       SET next_catalog_sync_at = NOW() + ((s.id % 12) * interval '3 minutes'),

           next_metrics_sync_at = COALESCE(

             s.next_metrics_sync_at,

             NOW() + interval '${METRICS_INTERVAL_DAYS} days'

           ),

           clicks_30d_next_sync_at = COALESCE(

             s.clicks_30d_next_sync_at,

             NOW() + ((s.id % 24) * interval '5 minutes')

           )

       FROM ebay_accounts ea

       WHERE ea.store_id = s.id

         AND ea.workspace_id = s.workspace_id

         AND s.status = 'active'

         AND ea.access_token IS NOT NULL

         AND ea.refresh_token IS NOT NULL

         AND (s.next_catalog_sync_at IS NULL OR s.clicks_30d_next_sync_at IS NULL)`

    )

  } catch (e) {

    console.warn(

      "[StoreSyncSchedule] Init skipped — run migrations 023 + 029",

      e instanceof Error ? e.message : e

    )

  }

}



/** Recover clicks sync stuck in running after backend restart. */

export async function recoverStaleClicks30dSync(): Promise<number> {

  try {

    const res = await query(

      `UPDATE stores

       SET clicks_30d_sync_status = 'idle',

           clicks_30d_next_sync_at = ${clicksErrorRetrySql()},

           updated_at = NOW()

       WHERE clicks_30d_sync_status = 'running'

         AND updated_at < NOW() - interval '${CLICKS_STALE_RUNNING_MIN} minutes'

       RETURNING id`

    )

    const n = res.rowCount ?? 0

    if (n > 0) {

      console.warn(`[StoreSyncSchedule] Recovered ${n} stale clicks_30d sync job(s)`)

    }

    return n

  } catch {

    return 0

  }

}



/** Recover catalog sync stuck in catalog_running (crash / pool kill). */

export async function recoverStaleCatalogSync(): Promise<number> {

  try {

    const res = await query(

      `UPDATE stores

       SET sync_status = 'error',

           sync_error = 'STALE_CATALOG_RUNNING recovered',

           next_catalog_sync_at = ${errorRetrySql()},

           updated_at = NOW()

       WHERE sync_status = 'catalog_running'

         AND updated_at < NOW() - interval '${CATALOG_STALE_RUNNING_MIN} minutes'

       RETURNING id`

    )

    const n = res.rowCount ?? 0

    if (n > 0) {

      console.warn(`[StoreSyncSchedule] Recovered ${n} stale catalog_running job(s)`)

    }

    return n

  } catch {

    return 0

  }

}



/**

 * Claim exclusive catalog sync ownership for exact store_id.

 * Returns false if another sync already holds catalog_running.

 */

export async function tryClaimCatalogSyncOwnership(storeId: number): Promise<boolean> {

  if (!Number.isInteger(storeId) || storeId < 1) return false

  const res = await query<{ id: number }>(

    `UPDATE stores

     SET sync_status = 'catalog_running',

         sync_error = NULL,

         updated_at = NOW()

     WHERE id = $1

       AND status = 'active'

       AND COALESCE(sync_status, '') <> 'catalog_running'

     RETURNING id`,

    [storeId]

  )

  return (res.rowCount ?? 0) > 0

}



export async function recordCatalogSyncFailed(storeId: number, message: string): Promise<void> {

  try {

    await markCatalogError(storeId, message)

  } catch {

    /* migration 023 may not be applied yet */

  }

}



async function pickNextJob(): Promise<DueJob | null> {

  const result = await query<{

    workspace_id: string

    store_code:   string

    store_id:     number

    job_type:     "catalog" | "metrics" | "clicks_30d"

  }>(

    `SELECT s.workspace_id,

            s.store_code,

            s.id AS store_id,

            CASE

              WHEN s.next_catalog_sync_at IS NOT NULL

                   AND s.next_catalog_sync_at <= NOW()

                   AND COALESCE(s.sync_status, '') <> 'catalog_running' THEN 'catalog'

              WHEN s.next_metrics_sync_at IS NOT NULL

                   AND s.next_metrics_sync_at <= NOW() THEN 'metrics'

              WHEN s.clicks_30d_next_sync_at IS NOT NULL

                   AND s.clicks_30d_next_sync_at <= NOW()

                   AND COALESCE(s.clicks_30d_sync_status, '') <> 'running' THEN 'clicks_30d'

            END AS job_type

     FROM stores s

     INNER JOIN ebay_accounts ea

       ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id

     WHERE s.status = 'active'

       AND ea.access_token IS NOT NULL

       AND ea.refresh_token IS NOT NULL

       AND (

         (s.next_catalog_sync_at IS NOT NULL AND s.next_catalog_sync_at <= NOW()

          AND COALESCE(s.sync_status, '') <> 'catalog_running')

         OR (s.next_metrics_sync_at IS NOT NULL AND s.next_metrics_sync_at <= NOW())

         OR (

           s.clicks_30d_next_sync_at IS NOT NULL

           AND s.clicks_30d_next_sync_at <= NOW()

           AND COALESCE(s.clicks_30d_sync_status, '') <> 'running'

         )

       )

     ORDER BY

       CASE

         WHEN s.next_catalog_sync_at IS NOT NULL AND s.next_catalog_sync_at <= NOW()

              AND COALESCE(s.sync_status, '') <> 'catalog_running' THEN 0

         WHEN s.next_metrics_sync_at IS NOT NULL AND s.next_metrics_sync_at <= NOW() THEN 1

         ELSE 2

       END,

       LEAST(

         COALESCE(s.next_catalog_sync_at, 'infinity'::timestamptz),

         COALESCE(s.next_metrics_sync_at, 'infinity'::timestamptz),

         COALESCE(s.clicks_30d_next_sync_at, 'infinity'::timestamptz)

       ) ASC

     LIMIT 1`

  )

  const row = result.rows[0]

  if (!row?.job_type) return null

  return {

    workspaceId: row.workspace_id,

    storeCode:   row.store_code,

    storeId:     row.store_id,

    jobType:     row.job_type,

  }

}



async function markCatalogSuccess(storeId: number): Promise<void> {

  await query(

    `UPDATE stores

     SET last_catalog_sync_at = NOW(),

         next_catalog_sync_at = ${catalogIntervalSql()},

         sync_status = 'ok',

         sync_error = NULL,

         updated_at = NOW()

     WHERE id = $1`,

    [storeId]

  )

}



async function markCatalogError(storeId: number, message: string): Promise<void> {

  await query(

    `UPDATE stores

     SET sync_status = 'error',

         sync_error = $2,

         next_catalog_sync_at = ${errorRetrySql()},

         updated_at = NOW()

     WHERE id = $1`,

    [storeId, message.slice(0, 500)]

  )

}



async function markMetricsSuccess(storeId: number): Promise<void> {

  await query(

    `UPDATE stores

     SET last_metrics_sync_at = NOW(),

         next_metrics_sync_at = ${metricsIntervalSql()},

         sync_status = 'ok',

         sync_error = NULL,

         updated_at = NOW()

     WHERE id = $1`,

    [storeId]

  )

}



async function markMetricsError(storeId: number, message: string): Promise<void> {

  await query(

    `UPDATE stores

     SET sync_status = 'error',

         sync_error = $2,

         next_metrics_sync_at = ${errorRetrySql()},

         updated_at = NOW()

     WHERE id = $1`,

    [storeId, message.slice(0, 500)]

  )

}



async function markClicks30dSuccess(

  storeId: number,

  checked: number,

  updated: number

): Promise<void> {

  await query(

    `UPDATE stores

     SET clicks_30d_last_sync_at = NOW(),

         clicks_30d_next_sync_at = ${clicks30dIntervalSql()},

         clicks_30d_sync_status = 'ok',

         clicks_30d_sync_error = NULL,

         clicks_30d_last_checked_count = $2,

         clicks_30d_last_updated_count = $3,

         updated_at = NOW()

     WHERE id = $1`,

    [storeId, checked, updated]

  )

}



async function markClicks30dAnalyticsMissing(storeId: number): Promise<void> {

  await query(

    `UPDATE stores

     SET clicks_30d_sync_status = 'analytics_missing',

         clicks_30d_sync_error = NULL,

         clicks_30d_next_sync_at = ${clicks30dIntervalSql()},

         updated_at = NOW()

     WHERE id = $1`,

    [storeId]

  )

}



async function markClicks30dError(storeId: number, message: string): Promise<void> {

  await query(

    `UPDATE stores

     SET clicks_30d_sync_status = 'error',

         clicks_30d_sync_error = $2,

         clicks_30d_next_sync_at = ${clicksErrorRetrySql()},

         updated_at = NOW()

     WHERE id = $1`,

    [storeId, message.slice(0, 500)]

  )

}



async function runCatalogJob(job: DueJob): Promise<void> {

  console.log(`[StoreSyncSchedule] Catalog sync start store=${job.storeCode} store_id=${job.storeId}`)

  try {

    const { syncListingsForStoreId } = await import("../listings/listingsSyncService")

    // Ownership claimed inside syncListingsForStore (exact store_id).

    const result = await syncListingsForStoreId(job.workspaceId, job.storeId)

    // sync path already calls recordCatalogSyncComplete; keep mark for scheduler log consistency.

    await markCatalogSuccess(job.storeId)

    console.log(

      `[StoreSyncSchedule] Catalog sync done store=${job.storeCode} store_id=${job.storeId} inserted=${result.inserted} updated=${result.updated}`

    )

  } catch (e) {

    const msg = e instanceof Error ? e.message : String(e)

    // Already-running is a coalesce, not a hard failure for the queue.

    if (/already running/i.test(msg)) {

      console.log(

        `[StoreSyncSchedule] Catalog sync skipped store=${job.storeCode} store_id=${job.storeId}: ${msg}`

      )

      return

    }

    await markCatalogError(job.storeId, msg)

    console.error(`[StoreSyncSchedule] Catalog sync failed store=${job.storeCode} store_id=${job.storeId}:`, msg)

  }

}



async function runMetricsJob(job: DueJob): Promise<void> {

  console.log(`[StoreSyncSchedule] Metrics sync start store=${job.storeCode}`)

  await query(

    `UPDATE stores SET sync_status = 'metrics_running' WHERE id = $1`,

    [job.storeId]

  )

  try {

    await syncListingMetrics(job.workspaceId, { storeCode: job.storeCode })

    await markMetricsSuccess(job.storeId)

    console.log(`[StoreSyncSchedule] Metrics sync done store=${job.storeCode}`)

  } catch (e) {

    const msg = e instanceof Error ? e.message : String(e)

    await markMetricsError(job.storeId, msg)

    console.error(`[StoreSyncSchedule] Metrics sync failed store=${job.storeCode}:`, msg)

  }

}



async function runClicks30dJob(job: DueJob): Promise<void> {

  console.log(`[StoreSyncSchedule] 30D clicks sync start store=${job.storeCode}`)

  await query(

    `UPDATE stores SET clicks_30d_sync_status = 'running' WHERE id = $1`,

    [job.storeId]

  )

  try {

    const result = await sync30dClicksForStore(job.workspaceId, job.storeCode)



    if (result.missingAnalyticsPermission) {

      await markClicks30dAnalyticsMissing(job.storeId)

      console.log(

        `[StoreSyncSchedule] 30D clicks skipped (analytics missing) store=${job.storeCode}`

      )

      return

    }



    if (!result.ok) {

      await markClicks30dError(job.storeId, result.message)

      console.warn(

        `[StoreSyncSchedule] 30D clicks sync failed store=${job.storeCode}: ${result.message}`

      )

      return

    }



    await markClicks30dSuccess(job.storeId, result.checked, result.updated)

    console.log(

      `[StoreSyncSchedule] 30D clicks sync done store=${job.storeCode} checked=${result.checked} updated=${result.updated}`

    )

  } catch (e) {

    const msg = e instanceof Error ? e.message : String(e)

    await markClicks30dError(job.storeId, msg)

    console.error(`[StoreSyncSchedule] 30D clicks sync failed store=${job.storeCode}:`, msg)

  }

}



export async function processStoreSyncQueue(): Promise<void> {

  if (processing) return

  processing = true

  try {

    await recoverStaleClicks30dSync()

    await recoverStaleCatalogSync()

    const job = await pickNextJob()

    if (!job) return

    if (job.jobType === "catalog") {

      await runCatalogJob(job)

    } else if (job.jobType === "metrics") {

      await runMetricsJob(job)

    } else {

      await runClicks30dJob(job)

    }

  } catch (e) {

    console.error("[StoreSyncSchedule] Queue tick failed:", e)

  } finally {

    processing = false

  }

}



export function startStoreSyncScheduler(): void {

  if (schedulerStarted) return

  schedulerStarted = true



  void initializeStoreSyncSchedule().then(() => processStoreSyncQueue())



  setInterval(() => {

    void processStoreSyncQueue()

  }, MAIN_TICK_MS)



  setInterval(() => {

    void processStoreSyncQueue()

  }, CLICKS_DUE_CHECK_MS)



  console.log(

    `[StoreSyncSchedule] Started (catalog ${CATALOG_INTERVAL_HOURS}h, metrics ${METRICS_INTERVAL_DAYS}d, ` +

      `30D clicks ${CLICKS_30D_INTERVAL_HOURS}h, due check every ${CLICKS_DUE_CHECK_MS / 60000}m)`

  )

}



/** Kick the in-process due-job queue (manual sync / OAuth bootstrap). */

export function requestStoreSyncQueueTick(): void {

  void processStoreSyncQueue()

}



export async function recordCatalogSyncComplete(storeId: number): Promise<void> {

  try {

    await markCatalogSuccess(storeId)

  } catch {

    /* migration 023 may not be applied yet */

  }

}



export async function recordMetricsSyncComplete(storeId: number): Promise<void> {

  try {

    await markMetricsSuccess(storeId)

  } catch {

    /* migration 023 may not be applied yet */

  }

}

export async function recordClicks30dSyncFromResult(
  workspaceId: string,
  storeCode: string,
  result: Sync30dClicksResponse
): Promise<void> {
  try {
    const res = await query<{ id: number }>(
      `SELECT id FROM stores
       WHERE workspace_id = $1::uuid AND store_code = $2 AND status = 'active' LIMIT 1`,
      [workspaceId, storeCode.trim()]
    )
    const storeId = res.rows[0]?.id
    if (!storeId) return

    if (result.missingAnalyticsPermission) {
      await markClicks30dAnalyticsMissing(storeId)
    } else if (!result.ok) {
      await markClicks30dError(storeId, result.message)
    } else {
      await markClicks30dSuccess(storeId, result.checked, result.updated)
    }
  } catch {
    /* migration 029 may not be applied yet */
  }
}

export type StoreSyncStatus = {

  lastCatalogSyncAt: string | null

  lastMetricsSyncAt: string | null

  syncStatus:        string | null

  syncError:         string | null

}



export type Clicks30dSyncStatus = {

  storeCode:              string

  analyticsScopeActive:   boolean

  clicks30dLastSyncAt:    string | null

  clicks30dNextSyncAt:    string | null

  clicks30dSyncStatus:    string | null

  clicks30dSyncError:     string | null

  lastCheckedCount:       number | null

  lastUpdatedCount:       number | null

}



export async function fetchStoreSyncStatus(

  storeId: number

): Promise<StoreSyncStatus | null> {

  try {

    const result = await query<{

      last_catalog_sync_at: string | null

      last_metrics_sync_at: string | null

      sync_status:          string | null

      sync_error:           string | null

    }>(

      `SELECT last_catalog_sync_at::text,

              last_metrics_sync_at::text,

              sync_status,

              sync_error

       FROM stores WHERE id = $1 LIMIT 1`,

      [storeId]

    )

    const row = result.rows[0]

    if (!row) return null

    return {

      lastCatalogSyncAt: row.last_catalog_sync_at?.trim() || null,

      lastMetricsSyncAt: row.last_metrics_sync_at?.trim() || null,

      syncStatus:        row.sync_status?.trim() || null,

      syncError:         row.sync_error?.trim() || null,

    }

  } catch {

    return null

  }

}



export async function fetchClicks30dSyncStatusByStoreCode(

  workspaceId: string,

  storeCode: string

): Promise<Clicks30dSyncStatus | null> {

  try {

    const result = await query<{

      store_code: string

      scope: string | null

      clicks_30d_last_sync_at: string | null

      clicks_30d_next_sync_at: string | null

      clicks_30d_sync_status: string | null

      clicks_30d_sync_error: string | null

      clicks_30d_last_checked_count: number | null

      clicks_30d_last_updated_count: number | null

    }>(

      `SELECT s.store_code,

              ea.scope,

              s.clicks_30d_last_sync_at::text,

              s.clicks_30d_next_sync_at::text,

              s.clicks_30d_sync_status,

              s.clicks_30d_sync_error,

              s.clicks_30d_last_checked_count,

              s.clicks_30d_last_updated_count

       FROM stores s

       LEFT JOIN ebay_accounts ea

         ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id

       WHERE s.workspace_id = $1::uuid

         AND s.store_code = $2

         AND s.status = 'active'

       LIMIT 1`,

      [workspaceId, storeCode]

    )

    const row = result.rows[0]

    if (!row) return null

    return {

      storeCode:            row.store_code,

      analyticsScopeActive: accountHasAnalyticsScope(row.scope),

      clicks30dLastSyncAt:  row.clicks_30d_last_sync_at?.trim() || null,

      clicks30dNextSyncAt:  row.clicks_30d_next_sync_at?.trim() || null,

      clicks30dSyncStatus:  row.clicks_30d_sync_status?.trim() || null,

      clicks30dSyncError:   row.clicks_30d_sync_error?.trim() || null,

      lastCheckedCount:     row.clicks_30d_last_checked_count,

      lastUpdatedCount:     row.clicks_30d_last_updated_count,

    }

  } catch {

    return null

  }

}



export async function fetchAllClicks30dSyncStatuses(

  workspaceId: string

): Promise<Clicks30dSyncStatus[]> {

  try {

    const result = await query<{

      store_code: string

      scope: string | null

      clicks_30d_last_sync_at: string | null

      clicks_30d_next_sync_at: string | null

      clicks_30d_sync_status: string | null

      clicks_30d_sync_error: string | null

      clicks_30d_last_checked_count: number | null

      clicks_30d_last_updated_count: number | null

    }>(

      `SELECT s.store_code,

              ea.scope,

              s.clicks_30d_last_sync_at::text,

              s.clicks_30d_next_sync_at::text,

              s.clicks_30d_sync_status,

              s.clicks_30d_sync_error,

              s.clicks_30d_last_checked_count,

              s.clicks_30d_last_updated_count

       FROM stores s

       INNER JOIN ebay_accounts ea

         ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id

       WHERE s.workspace_id = $1::uuid

         AND s.status = 'active'

         AND ea.access_token IS NOT NULL

         AND ea.refresh_token IS NOT NULL

       ORDER BY s.store_code`,

      [workspaceId]

    )

    return result.rows.map(row => ({

      storeCode:            row.store_code,

      analyticsScopeActive: accountHasAnalyticsScope(row.scope),

      clicks30dLastSyncAt:  row.clicks_30d_last_sync_at?.trim() || null,

      clicks30dNextSyncAt:  row.clicks_30d_next_sync_at?.trim() || null,

      clicks30dSyncStatus:  row.clicks_30d_sync_status?.trim() || null,

      clicks30dSyncError:   row.clicks_30d_sync_error?.trim() || null,

      lastCheckedCount:     row.clicks_30d_last_checked_count,

      lastUpdatedCount:     row.clicks_30d_last_updated_count,

    }))

  } catch {

    return []

  }

}


