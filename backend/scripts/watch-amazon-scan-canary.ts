import "dotenv/config"
import { query } from "../db/client"

const OP = "CANARY_20260920T111744Z"
const STARTED = Date.now()
const LIMIT_MS = 120_000

type Counts = Record<string, number>

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
  if (row.status === "FAILED" || row.status === "RETRYABLE") return "failed_or_retry"
  if (row.status !== "COMPLETED") return row.status.toLowerCase()
  const payload = row.payload ?? {}
  const meta = (payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}) as Record<string, unknown>
  if (payload.captcha === true || payload.timeout === true) return payload.captcha === true ? "captcha" : "timeout"
  const publicStatus = String(meta.publicStatus ?? "")
  if (publicStatus === "AMAZON_INCOMPLETE" || meta.offerPageHealthy === false && !payload.displayedPrice) {
    if (publicStatus === "AMAZON_INCOMPLETE") return "incomplete"
  }
  if (publicStatus === "AMAZON_INCOMPLETE") return "incomplete"
  if (payload.uncertain === true) return "incomplete"
  return "valid"
}

async function snapshot(): Promise<Record<string, unknown>> {
  const jobs = await query<{
    id: number
    asin: string
    kind: string
    status: string
    worker_id: string | null
    failure_code: string | null
    failure_message: string | null
    result_payload: Record<string, unknown> | null
    lease_expires_at: Date | null
    parent_job_id: string | null
  }>(
    `SELECT id, asin, kind, status, worker_id, failure_code, failure_message,
            result_payload, lease_expires_at, parent_job_id::text
     FROM amazon_scan_jobs
     WHERE session_class = $1
     ORDER BY id`,
    [OP]
  )
  const buckets: Counts = {}
  let valid = 0
  let incomplete = 0
  let captcha = 0
  let timeout = 0
  const statusCounts: Counts = {}
  const kindCounts: Counts = {}
  for (const row of jobs.rows) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1
    kindCounts[row.kind] = (kindCounts[row.kind] ?? 0) + 1
    const c = classify({
      status: row.status,
      failure_code: row.failure_code,
      failure_message: row.failure_message,
      payload: row.result_payload,
    })
    buckets[c] = (buckets[c] ?? 0) + 1
    if (c === "valid") valid++
    if (c === "incomplete") incomplete++
    if (c === "captcha") captcha++
    if (c === "timeout") timeout++
  }
  const outbox = await query<{ status: string; n: string }>(
    `SELECT o.status, COUNT(*)::text AS n
     FROM amazon_scan_apply_outbox o
     JOIN amazon_scan_jobs j ON j.id = o.job_id
     WHERE j.session_class = $1
     GROUP BY o.status`,
    [OP]
  )
  const hb = await query<{
    worker_id: string
    status: string
    browser_running: boolean
    age_s: number
    current_job_id: string | null
    last_error: string | null
  }>(
    `SELECT worker_id, status, browser_running,
            EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at))::int AS age_s,
            current_job_id::text, last_error
     FROM amazon_scan_worker_heartbeat
     ORDER BY last_heartbeat_at DESC
     LIMIT 5`
  )
  const leased = jobs.rows.filter(j => j.status === "CLAIMED" || j.status === "RUNNING")
  return {
    elapsedMs: Date.now() - STARTED,
    n: jobs.rowCount,
    statusCounts,
    kindCounts,
    classBuckets: buckets,
    valid,
    incomplete,
    captcha,
    timeout,
    claimedOrRunning: (statusCounts.CLAIMED ?? 0) + (statusCounts.RUNNING ?? 0),
    completed: statusCounts.COMPLETED ?? 0,
    retryable: statusCounts.RETRYABLE ?? 0,
    failed: statusCounts.FAILED ?? 0,
    confirm: kindCounts.CONFIRM ?? 0,
    outbox: outbox.rows,
    heartbeat: hb.rows,
    leased: leased.map(j => ({ id: j.id, status: j.status, worker: j.worker_id })),
  }
}

async function main(): Promise<void> {
  const snaps: unknown[] = []
  while (Date.now() - STARTED < LIMIT_MS) {
    const s = await snapshot()
    snaps.push(s)
    console.log("tick", JSON.stringify(s))
    if (Date.now() - STARTED + 12000 >= LIMIT_MS) break
    await new Promise(r => setTimeout(r, 12000))
  }
  const last = (await snapshot()) as Record<string, unknown>
  const elapsedMin = Math.max(Number(last.elapsedMs) / 60000, 1 / 60)
  const validPm = Math.round((Number(last.valid) / elapsedMin) * 100) / 100
  const claimed = Number(last.claimedOrRunning ?? 0)
  const completed = Number(last.completed ?? 0)
  const noCompletion = completed === 0
  const claimStuck = claimed === 0 && completed === 0 && Number(last.n) === 8
  console.log("FINAL", JSON.stringify({
    last,
    validPerMinute: validPm,
    noCompletion,
    claimStuck,
    elapsedMin: Math.round(elapsedMin * 100) / 100,
  }))
}

void main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
