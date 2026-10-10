import { query } from "../../db/client"
import { loadAmazonVerificationConfig } from "./amazonVerificationConfig"
import { countOnlineWorkers } from "./extensionWorkerRegistry"
import { getEbayMutationAudit } from "../ebay/ebayMutationAudit"
import { getStockGuardScannerMode } from "../stockGuard/stockGuardScannerOwnership"

export async function getPlatformAmazonVerificationStatus(): Promise<Record<string, unknown>> {
  const cfg = loadAmazonVerificationConfig()
  const onlineWorkers = await countOnlineWorkers()
  const buckets = await query<{
    pending: string
    claimed: string
    completed_1h: string
    completed_24h: string
    failed_24h: string
    fallback_24h: string
    oldest_pending_hours: string | null
    avg_duration_seconds: string | null
  }>(
    `SELECT
       SUM(CASE WHEN status IN ('PENDING','RETRYABLE','WAITING_FOR_WORKER') THEN 1 ELSE 0 END)::text AS pending,
       SUM(CASE WHEN status IN ('CLAIMED','RUNNING') THEN 1 ELSE 0 END)::text AS claimed,
       SUM(CASE WHEN status = 'COMPLETED' AND completed_at >= NOW() - interval '1 hour' THEN 1 ELSE 0 END)::text AS completed_1h,
       SUM(CASE WHEN status = 'COMPLETED' AND completed_at >= NOW() - interval '24 hours' THEN 1 ELSE 0 END)::text AS completed_24h,
       SUM(CASE WHEN status = 'FAILED' AND updated_at >= NOW() - interval '24 hours' THEN 1 ELSE 0 END)::text AS failed_24h,
       SUM(CASE WHEN reason IN ('PRICE_AMBIGUOUS','KEEPA_PRODUCT_UNRESOLVED','KEEPA_UNRESOLVED')
                 AND created_at >= NOW() - interval '24 hours' THEN 1 ELSE 0 END)::text AS fallback_24h,
       EXTRACT(EPOCH FROM (NOW() - MIN(CASE
         WHEN status IN ('PENDING','RETRYABLE','WAITING_FOR_WORKER') THEN created_at
         ELSE NULL
       END))) / 3600 AS oldest_pending_hours,
       AVG(CASE
         WHEN status = 'COMPLETED' AND completed_at >= NOW() - interval '24 hours' AND claimed_at IS NOT NULL
         THEN EXTRACT(EPOCH FROM (completed_at - claimed_at))
         ELSE NULL
       END) AS avg_duration_seconds
     FROM amazon_price_verification_tasks`
  )
  const r = buckets.rows[0]
  const pending = parseInt(r?.pending ?? "0", 10) || 0
  const claimed = parseInt(r?.claimed ?? "0", 10) || 0
  const workerCapacityStatus =
    pending > 0 && onlineWorkers === 0 ? "WAITING_FOR_WORKER" : pending > cfg.keepaFallbackMaxPendingTasks * 0.8 ? "BACKPRESSURE" : "OK"

  const ebayMutations = getEbayMutationAudit()
  const scannerMode = getStockGuardScannerMode()

  return {
    enabled: cfg.verificationEnabled,
    keepaDispatchEnabled: cfg.keepaDispatchEnabled,
    applySourcePrice: cfg.applySourcePrice,
    verifiedStockActionsEnabled: cfg.verifiedStockActionsEnabled,
    scannerMode,
    onlineWorkers,
    pendingVerificationTasks: pending,
    claimedVerificationTasks: claimed,
    completedLast1h: parseInt(r?.completed_1h ?? "0", 10) || 0,
    completedLast24h: parseInt(r?.completed_24h ?? "0", 10) || 0,
    failedLast24h: parseInt(r?.failed_24h ?? "0", 10) || 0,
    oldestPendingAgeHours: r?.oldest_pending_hours != null ? Number(r.oldest_pending_hours) : null,
    avgVerificationDurationSeconds: r?.avg_duration_seconds != null ? Number(r.avg_duration_seconds) : null,
    keepaFallbackTasksLast24h: parseInt(r?.fallback_24h ?? "0", 10) || 0,
    workerCapacityStatus,
    ebayQuantityMutations: ebayMutations.real.quantity,
    ebayPriceMutations: ebayMutations.real.price,
    ebayEndMutations: ebayMutations.real.end,
    ebayPublishMutations: ebayMutations.real.publish,
    ebayMutationsBlocked: ebayMutations.blocked,
    ebayRealMutationTotal: ebayMutations.realTotal,
  }
}

export async function handleGetPlatformAmazonVerificationStatus(): Promise<{ status: number; body: unknown }> {
  try {
    return { status: 200, body: await getPlatformAmazonVerificationStatus() }
  } catch (e) {
    return {
      status: 500,
      body: { error: "AmazonVerificationStatusFailed", message: e instanceof Error ? e.message : String(e) },
    }
  }
}

export async function handlePostPlatformAmazonVerificationTestTask(body: Record<string, unknown>): Promise<{
  status: number
  body: unknown
}> {
  try {
    const asins = Array.isArray(body.asins) ? body.asins.map(String) : typeof body.asin === "string" ? [body.asin] : []
    const workspaceId = String(body.workspaceId ?? "").trim()
    const preferredUserId = String(body.preferredUserId ?? "").trim()
    if (!workspaceId || !preferredUserId) {
      return { status: 400, body: { error: "workspaceId and preferredUserId are required" } }
    }
    const { enqueueAdminTestTasks } = await import("./amazonVerificationAdminEnqueue")
    const result = await enqueueAdminTestTasks({ asins, workspaceId, preferredUserId })
    return { status: 200, body: result }
  } catch (e) {
    const status = e && typeof e === "object" && "status" in e ? Number((e as { status: unknown }).status) : 500
    return {
      status: Number.isFinite(status) ? status : 500,
      body: { error: "TestTaskFailed", message: e instanceof Error ? e.message : String(e) },
    }
  }
}

export async function getTenantExtensionWorkerStatus(input: {
  workspaceId: string
  userId: string
}): Promise<Record<string, unknown>> {
  const cfg = loadAmazonVerificationConfig()
  const worker = await query<{
    last_heartbeat_at: Date
    amazon_available: boolean | null
    status: string
  }>(
    `SELECT last_heartbeat_at, amazon_available, status
     FROM extension_workers
     WHERE workspace_id = $1::uuid AND user_id = $2::uuid
     ORDER BY last_heartbeat_at DESC
     LIMIT 1`,
    [input.workspaceId, input.userId]
  )
  const pending = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM amazon_price_verification_tasks
     WHERE workspace_id = $1::uuid
       AND preferred_user_id = $2::uuid
       AND status IN ('PENDING','RETRYABLE','WAITING_FOR_WORKER','CLAIMED','RUNNING')`,
    [input.workspaceId, input.userId]
  )
  const last = worker.rows[0]
  const online =
    last != null &&
    Date.now() - new Date(last.last_heartbeat_at).getTime() <= cfg.workerOfflineAfterSeconds * 1000
  return {
    extensionConnected: online,
    lastHeartbeat: last?.last_heartbeat_at ?? null,
    amazonAvailable: last?.amazon_available ?? null,
    pendingOwnTasks: parseInt(pending.rows[0]?.c ?? "0", 10) || 0,
  }
}
