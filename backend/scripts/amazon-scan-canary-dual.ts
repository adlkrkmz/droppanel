import "dotenv/config"
import { enqueueScanJob } from "../modules/amazonScan/amazonScanJobQueue"
import { loadAmazonScanConfig } from "../modules/amazonScan/amazonScanConfig"
import { query } from "../db/client"

const PREV = "CANARY_20260920T111744Z"

function classify(row: {
  status: string
  failure_code: string | null
  failure_message: string | null
  payload: Record<string, unknown> | null
}): string {
  const code = String(row.failure_code ?? "")
  const msg = String(row.failure_message ?? "")
  if (code === "CAPTCHA" || code === "CHALLENGE_REQUIRED" || row.status === "WAITING_FOR_WORKER") return "captcha"
  if (/TIMEOUT/i.test(code) || /TIMEOUT/i.test(msg)) return "timeout"
  if (row.status === "FAILED") return "failed"
  if (row.status === "RETRYABLE") return "retry"
  if (row.status !== "COMPLETED") return row.status.toLowerCase()
  const payload = row.payload ?? {}
  const meta = (payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}) as Record<string, unknown>
  if (payload.captcha === true) return "captcha"
  if (payload.timeout === true) return "timeout"
  if (String(meta.publicStatus ?? "") === "AMAZON_INCOMPLETE" || payload.uncertain === true) return "incomplete"
  return "valid"
}

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[i] ?? null
}

async function main(): Promise<void> {
  const cfg = loadAmazonScanConfig()
  if (cfg.plannerEnabled) throw new Error("planner must be false")
  if (cfg.applyProcessorEnabled) throw new Error("apply must be false")

  const prevAsins = await query<{ asin: string }>(
    `SELECT DISTINCT asin FROM amazon_scan_jobs WHERE session_class = $1`,
    [PREV]
  )
  const skip = prevAsins.rows.map(r => r.asin.toUpperCase())

  const picked = await query<{ id: string; asin: string }>(
    `SELECT g.id::text AS id, g.asin
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     WHERE COALESCE(scs.stock_guard_enabled, true) = true
       AND (scs.current_status IS NULL OR scs.current_status = 'live')
       AND scs.ebay_item_id IS NOT NULL AND BTRIM(scs.ebay_item_id) <> ''
       AND st.status = 'active'
       AND scs.workspace_id = c.workspace_id
       AND scs.store_id = c.store_id
       AND COALESCE(scs.ebay_quantity, 0) > 0
       AND g.asin ~ '^[A-Z0-9]{10}$'
       AND NOT (g.asin = ANY($1::text[]))
     GROUP BY g.id, g.asin
     ORDER BY MIN(
       CASE
         WHEN COALESCE(scs.total_sold, 0) > 0 OR COALESCE(scs.sold_30d, 0) > 0 THEN 0
         WHEN COALESCE(scs.clicks_30d, 0) > 0 THEN 1
         ELSE 2
       END
     ), g.asin
     LIMIT 16`,
    [skip]
  )
  if (picked.rowCount !== 16) throw new Error(`need 16 asins, got ${picked.rowCount}`)
  const asins = picked.rows.map(r => r.asin.toUpperCase())
  if (new Set(asins).size !== 16) throw new Error("asins not unique")

  const op = `CANARY_DUAL_${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`
  const enqueueStart = new Date()
  const created: number[] = []
  for (const row of picked.rows) {
    const made = await enqueueScanJob({
      globalAsinId: Number(row.id),
      asin: row.asin,
      marketplace: cfg.marketplace,
      deliveryZip: cfg.deliveryZip,
      sessionClass: op,
      kind: "ROUTINE",
      priority: 0,
      requireFreshNav: false,
    })
    if (!made.created || !made.jobId) throw new Error(`enqueue failed ${row.asin} jobId=${made.jobId}`)
    created.push(made.jobId)
  }
  const enqueueDone = new Date()
  console.log(JSON.stringify({ phase: "enqueued", op, createdCount: created.length, enqueueMs: enqueueDone.getTime() - enqueueStart.getTime() }))

  const limitMs = 150_000
  const t0 = Date.now()
  let last: Record<string, unknown> = {}
  while (Date.now() - t0 < limitMs) {
    last = await snap(op, enqueueStart)
    console.log("tick", JSON.stringify({ elapsedMs: Date.now() - t0, ...summarize(last) }))
    const completed = Number((last.statusCounts as Record<string, number>).COMPLETED ?? 0)
    const pendingish =
      completed < 16 &&
      ((last.statusCounts as Record<string, number>).PENDING ?? 0) +
        ((last.statusCounts as Record<string, number>).CLAIMED ?? 0) +
        ((last.statusCounts as Record<string, number>).RUNNING ?? 0) +
        ((last.statusCounts as Record<string, number>).RETRYABLE ?? 0) +
        ((last.statusCounts as Record<string, number>).WAITING_FOR_WORKER ?? 0) >
        0
    if (completed === 16) break
    if (Date.now() - t0 + 8000 >= limitMs) break
    await new Promise(r => setTimeout(r, pendingish ? 8000 : 8000))
  }
  last = await snap(op, enqueueStart)
  const s = last as ReturnType<typeof Object>
  const workers = last.workers as Record<string, { claimed: number; completed: number; valid: number }>
  const valid = Number(last.valid ?? 0)
  const wallMs = Number(last.wallEnqueueToLastTerminalMs ?? 0)
  const procMs = Number(last.firstClaimToLastTerminalMs ?? 0)
  const validPerMinWall = wallMs > 0 ? Math.round((valid / (wallMs / 60000)) * 100) / 100 : null
  const validPerMinProc = procMs > 0 ? Math.round((valid / (procMs / 60000)) * 100) / 100 : null
  const noCompletion = Number((last.statusCounts as Record<string, number>).COMPLETED ?? 0) === 0
  const a = workers["amazon-public-browser-worker-A"] ?? { claimed: 0, completed: 0, valid: 0 }
  const b = workers["amazon-public-browser-worker-B"] ?? { claimed: 0, completed: 0, valid: 0 }
  const bothClaimBroken = a.claimed === 0 && b.claimed === 0 && noCompletion
  console.log(
    "FINAL",
    JSON.stringify({
      op,
      enqueueStart: enqueueStart.toISOString(),
      created: created.length,
      asins,
      last,
      validPerMinuteWall: validPerMinWall,
      validPerMinuteProcess: validPerMinProc,
      targetValidPerMinute: 8.9,
      noCompletion,
      bothClaimBroken,
      workerA: a,
      workerB: b,
    })
  )
}

async function snap(op: string, enqueueStart: Date): Promise<Record<string, unknown>> {
  const jobs = await query<{
    id: string
    asin: string
    kind: string
    status: string
    worker_id: string | null
    failure_code: string | null
    failure_message: string | null
    result_payload: Record<string, unknown> | null
    claimed_at: Date | null
    completed_at: Date | null
    observed_at: Date | null
  }>(
    `SELECT id::text, asin, kind, status, worker_id, failure_code, failure_message, result_payload,
            claimed_at, completed_at, observed_at
     FROM amazon_scan_jobs WHERE session_class = $1 ORDER BY id`,
    [op]
  )
  const statusCounts: Record<string, number> = {}
  const classBuckets: Record<string, number> = {}
  const workers: Record<string, { claimed: number; completed: number; valid: number; incomplete: number; failed: number }> = {}
  const durations: number[] = []
  let valid = 0
  let incomplete = 0
  let captcha = 0
  let timeout = 0
  let retry = 0
  let failed = 0
  let confirm = 0
  const claimedTimes: number[] = []
  const terminalTimes: number[] = []
  let stale = 0
  for (const row of jobs.rows) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1
    if (row.kind === "CONFIRM") confirm++
    const c = classify({
      status: row.status,
      failure_code: row.failure_code,
      failure_message: row.failure_message,
      payload: row.result_payload,
    })
    classBuckets[c] = (classBuckets[c] ?? 0) + 1
    if (c === "valid") valid++
    if (c === "incomplete") incomplete++
    if (c === "captcha") captcha++
    if (c === "timeout") timeout++
    if (c === "retry") retry++
    if (c === "failed") failed++
    if (/STALE/i.test(String(row.failure_code ?? "")) || /STALE/i.test(String(row.failure_message ?? ""))) stale++
    const wid = row.worker_id || "none"
    workers[wid] ??= { claimed: 0, completed: 0, valid: 0, incomplete: 0, failed: 0 }
    if (row.worker_id) workers[wid].claimed++
    if (row.status === "COMPLETED") workers[wid].completed++
    if (c === "valid") workers[wid].valid++
    if (c === "incomplete") workers[wid].incomplete++
    if (c === "failed") workers[wid].failed++
    if (row.claimed_at) claimedTimes.push(new Date(row.claimed_at).getTime())
    const term = row.completed_at || (row.status === "FAILED" || row.status === "WAITING_FOR_WORKER" ? row.observed_at : null)
    if (row.completed_at) terminalTimes.push(new Date(row.completed_at).getTime())
    else if (row.status === "FAILED" && row.observed_at) terminalTimes.push(new Date(row.observed_at).getTime())
    void term
    if (row.claimed_at && row.completed_at) {
      durations.push(new Date(row.completed_at).getTime() - new Date(row.claimed_at).getTime())
    }
  }
  durations.sort((a, b) => a - b)
  const avg = durations.length ? Math.round(durations.reduce((s, n) => s + n, 0) / durations.length) : null
  const firstClaim = claimedTimes.length ? Math.min(...claimedTimes) : null
  const lastTerminal = terminalTimes.length ? Math.max(...terminalTimes) : null
  const outbox = await query<{ status: string; n: string }>(
    `SELECT o.status, COUNT(*)::text AS n
     FROM amazon_scan_apply_outbox o
     JOIN amazon_scan_jobs j ON j.id = o.job_id
     WHERE j.session_class = $1
     GROUP BY o.status`,
    [op]
  )
  const prevOutbox = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM amazon_scan_apply_outbox o
     JOIN amazon_scan_jobs j ON j.id = o.job_id WHERE j.session_class = $1`,
    [PREV]
  )
  const hb = await query<{
    worker_id: string
    status: string
    age_s: number
    current_job_id: string | null
    last_error: string | null
  }>(
    `SELECT worker_id, status,
            EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at))::int AS age_s,
            current_job_id::text, last_error
     FROM amazon_scan_worker_heartbeat
     WHERE worker_id IN ('amazon-public-browser-worker-A','amazon-public-browser-worker-B')
     ORDER BY worker_id`
  )
  return {
    n: jobs.rowCount,
    statusCounts,
    classBuckets,
    workers,
    valid,
    incomplete,
    captcha,
    timeout,
    retry,
    failed,
    confirm,
    stale,
    outbox: outbox.rows,
    prevOutboxStill: Number(prevOutbox.rows[0]?.n ?? 0),
    heartbeat: hb.rows,
    avgTaskMs: avg,
    p95TaskMs: pct(durations, 0.95),
    durationsMs: durations,
    wallEnqueueToLastTerminalMs: lastTerminal ? lastTerminal - enqueueStart.getTime() : null,
    firstClaimToLastTerminalMs: firstClaim && lastTerminal ? lastTerminal - firstClaim : null,
    firstClaimAt: firstClaim ? new Date(firstClaim).toISOString() : null,
    lastTerminalAt: lastTerminal ? new Date(lastTerminal).toISOString() : null,
    leased: jobs.rows.filter(j => j.status === "CLAIMED" || j.status === "RUNNING").map(j => ({
      id: j.id,
      worker: j.worker_id,
      status: j.status,
    })),
  }
}

function summarize(last: Record<string, unknown>): Record<string, unknown> {
  return {
    statusCounts: last.statusCounts,
    valid: last.valid,
    incomplete: last.incomplete,
    workers: last.workers,
    captcha: last.captcha,
    timeout: last.timeout,
    retry: last.retry,
    failed: last.failed,
    stale: last.stale,
    heartbeat: last.heartbeat,
    leased: last.leased,
    outbox: last.outbox,
  }
}

void main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
