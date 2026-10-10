import "dotenv/config"
import assert from "assert"
import { query } from "../db/client"
import { authorizeKeepaCollector } from "../modules/keepaSensor/keepaCollectorAuth"
import { authorizeAmazonScanWorker } from "../modules/amazonScan/amazonScanWorkerAuth"
import { keepaCollectorProtocolEnabled } from "../modules/keepaSensor/keepaCollectorProtocol"

function collectorToken(): string {
  return (process.env.KEEPA_COLLECTOR_WORKER_TOKEN ?? "").trim()
}
function scanToken(): string {
  return (process.env.AMAZON_SCAN_WORKER_TOKEN ?? "").trim()
}

async function req(
  path: string,
  opts: { token?: string | null; method?: string; body?: unknown; cookie?: string; timeoutMs?: number }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.cookie) headers.cookie = opts.cookie
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 120_000)
  try {
    const res = await fetch(`http://127.0.0.1:4000${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      signal: ac.signal,
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { status: res.status, json }
  } finally {
    clearTimeout(t)
  }
}

async function fingerprint(): Promise<string> {
  const r = await query<{
    outbox: string
    outbox_max: Date | null
    state: string
    state_max: Date | null
    cand: string
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM keepa_asin_sync_outbox) AS outbox,
       (SELECT MAX(updated_at) FROM keepa_asin_sync_state) AS state_max,
       (SELECT COUNT(*)::text FROM keepa_asin_sync_state) AS state,
       (SELECT MAX(created_at) FROM keepa_asin_sync_outbox) AS outbox_max,
       (SELECT COUNT(*)::text FROM keepa_verify_candidates) AS cand`
  )
  const row = r.rows[0]
  return JSON.stringify({
    outbox: row.outbox,
    state: row.state,
    cand: row.cand,
    outboxMax: row.outbox_max ? new Date(row.outbox_max).toISOString() : null,
    stateMax: row.state_max ? new Date(row.state_max).toISOString() : null,
  })
}

async function main(): Promise<void> {
  assert.equal(keepaCollectorProtocolEnabled(), true)
  assert.ok(collectorToken().length >= 32)
  assert.notEqual(collectorToken(), scanToken())

  assert.equal(authorizeKeepaCollector(undefined).status, 401)
  assert.equal(authorizeKeepaCollector("Bearer not-a-real-token-value-000000000000").status, 401)
  if (scanToken().length >= 32) {
    const scanOnCollector = authorizeKeepaCollector(`Bearer ${scanToken()}`)
    assert.equal(scanOnCollector.ok, false)
    assert.equal(scanOnCollector.status, 401)
  }
  assert.equal(authorizeKeepaCollector(`Bearer ${collectorToken()}`).ok, true)
  assert.equal(authorizeAmazonScanWorker(`Bearer ${collectorToken()}`).ok, false)
  console.log("PASS in-process auth isolation (no token printed)")

  const none = await req("/internal/keepa-collector/heartbeat", { token: null })
  assert.equal(none.status, 401)
  const wrong = await req("/internal/keepa-collector/heartbeat", { token: "wrong-token-wrong-token-wrong-token" })
  assert.equal(wrong.status, 401)
  const cookie = await req("/internal/keepa-collector/heartbeat", {
    token: null,
    cookie: "session=admin-should-not-open-worker-routes",
  })
  assert.equal(cookie.status, 401)
  const hb = await req("/internal/keepa-collector/heartbeat", { token: collectorToken() })
  assert.equal(hb.status, 200)
  assert.equal(hb.json.ok, true)
  const st = await req("/internal/keepa-collector/status", { token: collectorToken() })
  assert.equal(st.status, 200)
  console.log("PASS HTTP heartbeat/status 200; missing/wrong/cookie 401")

  if (scanToken().length >= 32) {
    const scanHb = await req("/internal/keepa-collector/heartbeat", { token: scanToken() })
    assert.equal(scanHb.status, 401)
  }
  const claim = await req("/internal/amazon-scan/claim-next", {
    token: collectorToken(),
    method: "POST",
    body: { workerId: "probe-collector-must-not-claim" },
  })
  assert.equal(claim.status, 401)
  console.log("PASS cross-token HTTP 401 collector↔scan")

  const before = await fingerprint()
  const first = await req("/internal/keepa-collector/snapshot?limit=200", { token: collectorToken(), timeoutMs: 180_000 })
  assert.equal(first.status, 200, JSON.stringify({ status: first.status, err: first.json.error }))
  assert.equal(first.json.ok, true)
  const totals = first.json.totals as {
    uniqueAsins: number
    active: number
    pausedQtyZero: number
    sold: number
    standard: number
    excludedRemoved: number
    duplicateAsinRows: number
  }
  const watermark = first.json.watermark as { snapshotStartedAt: string }
  assert.ok(totals)
  assert.ok(watermark?.snapshotStartedAt)
  const seen = new Set<string>()
  let duplicates = 0
  let pages = 0
  let cursor = first.json.nextCursor as string | null
  let offsetSeq = Number(first.json.offsetSeq ?? 0)
  const pageItems = Array.isArray(first.json.items) ? (first.json.items as { asin: string; status: string; priority: string }[]) : []
  for (const it of pageItems) {
    if (seen.has(it.asin)) duplicates++
    seen.add(it.asin)
  }
  pages = 1
  while (cursor) {
    const page = await req(
      `/internal/keepa-collector/snapshot?limit=200&cursor=${encodeURIComponent(cursor)}&offsetSeq=${offsetSeq}`,
      { token: collectorToken(), timeoutMs: 180_000 }
    )
    assert.equal(page.status, 200)
    pages++
    const items = Array.isArray(page.json.items) ? (page.json.items as { asin: string }[]) : []
    for (const it of items) {
      if (seen.has(it.asin)) duplicates++
      seen.add(it.asin)
    }
    cursor = (page.json.nextCursor as string | null) ?? null
    offsetSeq = Number(page.json.offsetSeq ?? offsetSeq)
    if (pages > 80) break
  }
  const included = totals.active + totals.pausedQtyZero
  assert.equal(seen.size, included)
  assert.equal(duplicates, 0)
  assert.equal(totals.sold + totals.standard, totals.active)
  const after = await fingerprint()
  assert.equal(after, before)
  console.log(
    JSON.stringify({
      snapshotPages: pages,
      uniqueIncluded: seen.size,
      active: totals.active,
      pausedQtyZero: totals.pausedQtyZero,
      sold: totals.sold,
      standard: totals.standard,
      excludedRemoved: totals.excludedRemoved,
      uniqueAsinsResolved: totals.uniqueAsins,
      paginationDuplicates: duplicates,
      paginationMatchesTotals: seen.size === included,
      watermarkStarted: Boolean(watermark.snapshotStartedAt),
      snapshotDbUnchanged: after === before,
    })
  )

  const ev = await query<{
    pending: string
    oldest: Date | null
    type: string
    n: string
    dup_fp: string
    regress: string
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM keepa_asin_sync_outbox WHERE status = 'PENDING') AS pending,
       (SELECT MIN(created_at) FROM keepa_asin_sync_outbox WHERE status = 'PENDING') AS oldest,
       '' AS type,
       '0' AS n,
       (SELECT COUNT(*)::text FROM (
          SELECT asin, event_type, payload_fingerprint FROM keepa_asin_sync_outbox
          GROUP BY 1,2,3 HAVING COUNT(*) > 1
       ) d) AS dup_fp,
       (SELECT COUNT(*)::text FROM (
          SELECT asin FROM keepa_asin_sync_outbox
          GROUP BY asin
          HAVING MIN(source_version) > MIN(source_version)
       ) x) AS regress`
  )
  const types = await query<{ event_type: string; n: string }>(
    `SELECT event_type, COUNT(*)::text AS n FROM keepa_asin_sync_outbox GROUP BY event_type ORDER BY event_type`
  )
  const versionMono = await query<{ bad: string }>(
    `SELECT COUNT(*)::text AS bad FROM (
       SELECT asin FROM keepa_asin_sync_outbox o
       WHERE EXISTS (
         SELECT 1 FROM keepa_asin_sync_outbox p
         WHERE p.asin = o.asin AND p.created_at > o.created_at AND p.source_version < o.source_version
       )
     ) q`
  )
  console.log(
    JSON.stringify({
      pendingEvents: Number(ev.rows[0]?.pending ?? 0),
      oldestPendingAt: ev.rows[0]?.oldest ?? null,
      duplicateFingerprints: Number(ev.rows[0]?.dup_fp ?? 0),
      sourceVersionRegressions: Number(versionMono.rows[0]?.bad ?? 0),
      eventTypes: Object.fromEntries(types.rows.map(r => [r.event_type, Number(r.n)])),
    })
  )

  const httpsHealth = await fetch("https://api.listjetgo.com/health")
  const httpsJson = (await httpsHealth.json()) as { status?: string; services?: { db?: string } }
  assert.equal(httpsHealth.status, 200)
  assert.equal(httpsJson.services?.db, "ok")
  const httpsHb = await fetch("https://api.listjetgo.com/internal/keepa-collector/heartbeat", {
    headers: { authorization: `Bearer ${collectorToken()}` },
  })
  assert.equal(httpsHb.status, 200)
  console.log("PASS HTTPS health+heartbeat 200")
  console.log("PASS keepa-collector live protocol probe")
}

void main()
  .catch(e => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
  .then(() => process.exit(0))
