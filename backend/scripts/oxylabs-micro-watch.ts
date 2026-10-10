import "dotenv/config"
import { query } from "../db/client"
import { loadOxylabsPlanUsage } from "../modules/oxylabsVerify/oxylabsPlanUsage"
import fs from "fs"

const started = Date.now()
const t0 = { completed: 0, reserved: 0 }

async function snap() {
  const usage = await loadOxylabsPlanUsage()
  const jobs = await query<{ status: string; n: number }>(
    `SELECT status, COUNT(*)::int AS n FROM amazon_scan_jobs WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' GROUP BY status`
  )
  const conf = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM amazon_scan_jobs WHERE kind = 'OXYLABS_PRODUCT_CONFIRM'`
  )
  const pricing = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM amazon_scan_jobs WHERE provider ILIKE '%pricing%' OR kind ILIKE '%PRICING%'`
  )
  const hb = await query<{ last_heartbeat_at: Date; status: string; last_error: string }>(
    `SELECT last_heartbeat_at, status, left(COALESCE(last_error,''), 200) AS last_error
     FROM amazon_scan_worker_heartbeat WHERE worker_id = 'oxylabs-product-primary-A'`
  )
  const apply = await query(
    `SELECT COUNT(*) FILTER (WHERE created_at >= $1::timestamptz)::int AS new_n,
            COUNT(*) FILTER (WHERE ebay_mutate_count > 1 AND created_at >= $1::timestamptz)::int AS new_dup,
            MAX(created_at) AS last_created,
            MAX(applied_at) AS last_applied
     FROM oxylabs_apply_operations`,
    [new Date(started).toISOString()]
  )
  const alerts = await query(
    `SELECT MAX(created_at) AS t, COUNT(*) FILTER (WHERE created_at >= $1::timestamptz)::int AS new_n FROM stock_review_items`,
    [new Date(started).toISOString()]
  )
  const keepa = await query<{ collected_at: Date; payload: Record<string, unknown> }>(
    `SELECT collected_at, payload FROM keepa_collector_host_telemetry ORDER BY collected_at DESC LIMIT 1`
  )
  const p = (keepa.rows[0]?.payload || {}) as Record<string, unknown>
  const by = Object.fromEntries(jobs.rows.map(r => [r.status, r.n])) as Record<string, number>
  const completed = by.COMPLETED || 0
  const pending = by.PENDING || 0
  if (!t0.completed) {
    t0.completed = completed
    t0.reserved = usage.lifetimeReserved
  }
  const ageMs = hb.rows[0] ? Date.now() - new Date(hb.rows[0].last_heartbeat_at).getTime() : null
  const dueSold = Number(p.dueSold || 0)
  const dueStandard = Number(p.dueStandard || 0)
  const lastKeepaAt = p.lastKeepaAt ? new Date(String(p.lastKeepaAt)).getTime() : 0
  const keepaAgeMin = lastKeepaAt ? Math.round((Date.now() - lastKeepaAt) / 60000) : null
  let keepaClass = "UNKNOWN"
  if (dueSold + dueStandard === 0) keepaClass = "CADENCE_WAIT"
  else if (keepaAgeMin != null && keepaAgeMin <= 15) keepaClass = "RUNNING"
  else keepaClass = "STALE_WITH_DUE"
  const out = {
    at: new Date().toISOString(),
    elapsedSec: Math.round((Date.now() - started) / 1000),
    usage,
    jobs: by,
    deltaCompleted: completed - t0.completed,
    deltaReserved: usage.lifetimeReserved - t0.reserved,
    pending,
    claimed: (by.CLAIMED || 0) + (by.RUNNING || 0),
    confirmJobs: conf.rows[0].n,
    pricingJobs: pricing.rows[0].n,
    hbAgeSec: ageMs != null ? Math.round(ageMs / 1000) : null,
    lastError: hb.rows[0]?.last_error,
    apply: apply.rows[0],
    alerts: alerts.rows[0],
    keepa: {
      class: keepaClass,
      collectedAt: keepa.rows[0]?.collected_at,
      lastKeepaAt: p.lastKeepaAt,
      lastKeepaAgeMin: keepaAgeMin,
      dueSold,
      dueStandard,
      tokensLeft: p.tokensLeft,
      lastErrorCode: p.lastErrorCode,
      phase: p.phase,
      scanMode: p.scanMode,
      reconcileMatched: p.reconcileMatched,
    },
  }
  fs.writeFileSync("/tmp/oxylabs-micro-watch.json", JSON.stringify(out, null, 2))
  console.log(
    JSON.stringify({
      t: out.at.slice(11, 19),
      rem: usage.remaining,
      cycR: usage.cycleReserved,
      cycS: usage.cycleSuccessful,
      pend: pending,
      claimed: out.claimed,
      dDone: out.deltaCompleted,
      dRes: out.deltaReserved,
      hb: out.hbAgeSec,
      err: out.lastError,
      conf: out.confirmJobs,
      keepa: keepaClass,
    })
  )
  return out
}

async function main() {
  await snap()
  const until = Date.now() + 10 * 60 * 1000
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 20000))
    const s = await snap()
    const err = String(s.lastError || "")
    if (/\b(401|403|429|5\d\d)\b/.test(err) || /quota|plan|payment|insufficient/i.test(err)) {
      console.log("STOP_PROVIDER_ERROR", err)
      process.exit(2)
    }
    if (s.deltaCompleted >= 20 && s.elapsedSec >= 120) {
      console.log("STOP_20_COMPLETED")
      process.exit(0)
    }
  }
  console.log("STOP_10MIN")
  process.exit(0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
