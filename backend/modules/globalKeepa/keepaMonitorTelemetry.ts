import { query } from "../../db/client"

export type KeepaMonitorCaller = "V2_PLANNER" | "ADMIN_MANUAL" | "LEGACY_MANUAL"

export type KeepaAsinScanEventInput = {
  requestId?: string | null
  globalAsinId?: number | null
  asin: string
  priority?: number | null
  consumerCount?: number | null
  snapshotStatus?: string | null
  decisionCode?: string | null
  candidatePrice?: number | null
  amazonPrice?: number | null
  fbaCount?: number | null
  fbmCount?: number | null
  verifyQueued?: boolean
  tokensUsed?: number | null
  durationMs?: number | null
  errorType?: string | null
  caller?: KeepaMonitorCaller | null
}

export async function recordKeepaAsinScanEvent(input: KeepaAsinScanEventInput): Promise<void> {
  try {
    await query(
      `INSERT INTO keepa_asin_scan_events (
         request_id, global_asin_id, asin, priority, consumer_count,
         snapshot_status, decision_code, candidate_price, amazon_price,
         fba_count, fbm_count, verify_queued, tokens_used, duration_ms,
         error_type, caller, created_at
       ) VALUES (
         $1, $2::bigint, $3, $4::smallint,
         COALESCE($5::int, (SELECT COUNT(*)::int FROM global_asin_consumers WHERE global_asin_id = $2::bigint)),
         $6, $7, $8::numeric, $9::numeric,
         $10::int, $11::int, $12::boolean, $13::int, $14::int,
         $15, $16, NOW()
       )`,
      [
        input.requestId ?? null,
        input.globalAsinId ?? null,
        input.asin,
        input.priority ?? null,
        input.consumerCount ?? null,
        input.snapshotStatus ?? null,
        input.decisionCode ?? null,
        input.candidatePrice ?? null,
        input.amazonPrice ?? null,
        input.fbaCount ?? null,
        input.fbmCount ?? null,
        input.verifyQueued === true,
        input.tokensUsed ?? null,
        input.durationMs ?? null,
        input.errorType ?? null,
        input.caller ?? "V2_PLANNER",
      ]
    )
  } catch {
    /* observability must never fail the planner */
  }
}

export async function recordKeepaMonitorSample(input: {
  tokensLeft: number | null
  backlog: number | null
  uniqueAsinsProcessed: number | null
}): Promise<void> {
  try {
    await query(
      `INSERT INTO keepa_monitor_samples (tokens_left, backlog, unique_asins_processed, created_at)
       VALUES ($1::int, $2::int, $3::int, NOW())`,
      [input.tokensLeft, input.backlog, input.uniqueAsinsProcessed]
    )
  } catch {
    /* observability must never fail the planner */
  }
}

let lastPlannerTickAt: string | null = null
let lastPlannerTickSkipped: string | null = null
let lastSuccessfulKeepaRequestAt: string | null = null

export function notePlannerTickRuntime(input: { skipped?: string | null }): void {
  lastPlannerTickAt = new Date().toISOString()
  lastPlannerTickSkipped = input.skipped ?? null
}

export function noteSuccessfulKeepaRequest(): void {
  lastSuccessfulKeepaRequestAt = new Date().toISOString()
}

export function getKeepaMonitorRuntime(): {
  lastPlannerTickAt: string | null
  lastPlannerTickSkipped: string | null
  lastSuccessfulKeepaRequestAt: string | null
} {
  return {
    lastPlannerTickAt,
    lastPlannerTickSkipped,
    lastSuccessfulKeepaRequestAt,
  }
}
