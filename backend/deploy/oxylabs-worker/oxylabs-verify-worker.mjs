#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite"
import { readFileSync, existsSync } from "node:fs"
import { hostname } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
  migrateOxylabsWorkerLedger,
  processClaimedJob,
  pendingOutbox,
  loadJob,
  bumpResultSubmitAttempt,
  bumpFailSubmitAttempt,
  markResultSubmitted,
  markFailSubmitted,
} from "./oxylabs-verify-ledger.mjs"

export const VERSION = "1.0.2"
const __dirname = dirname(fileURLToPath(import.meta.url))

function loadDotenv() {
  const p = join(__dirname, ".env")
  if (!existsSync(p)) return
  const text = readFileSync(p, "utf8")
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const i = t.indexOf("=")
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[k] == null) process.env[k] = v
  }
}
loadDotenv()

if (String(process.env.OXYLABS_PRICING_ENABLED ?? "").trim().toLowerCase() === "true") {
  console.error("[oxylabs-worker] OXYLABS_PRICING_ENABLED=true is forbidden")
  process.exit(1)
}
if (String(process.env.OXYLABS_DIRECT_MUTATIONS_ENABLED ?? "").trim().toLowerCase() === "true") {
  console.error("[oxylabs-worker] OXYLABS_DIRECT_MUTATIONS_ENABLED=true is forbidden")
  process.exit(1)
}
if (String(process.env.OXYLABS_SOURCE ?? "amazon_product").trim() === "amazon_pricing") {
  console.error("[oxylabs-worker] amazon_pricing source is forbidden")
  process.exit(1)
}

const API = String(process.env.LISTJETGO_API_BASE ?? "").replace(/\/$/, "")
const TOKEN = String(process.env.OXYLABS_VERIFY_WORKER_TOKEN ?? "").trim()
const ROLE = String(process.env.OXYLABS_WORKER_ROLE ?? "PRIMARY").trim().toUpperCase()
const SLOT = String(process.env.OXYLABS_WORKER_SLOT ?? (ROLE === "CONFIRM" ? "C" : "A")).trim().toUpperCase()
const WORKER_ID = ROLE === "CONFIRM" ? `oxylabs-product-confirm-${SLOT}` : `oxylabs-product-primary-${SLOT}`
const SOURCE = String(process.env.OXYLABS_SOURCE ?? "amazon_product").trim() || "amazon_product"
const GEO = String(process.env.OXYLABS_GEO_LOCATION ?? "10001").trim() || "10001"
const PARSE = String(process.env.OXYLABS_PARSE ?? "true").trim().toLowerCase() !== "false"
const POLL_MS = Math.max(1000, parseInt(process.env.OXYLABS_POLL_MS ?? "4000", 10) || 4000)
const OXY_BASE = String(process.env.OXYLABS_API_BASE ?? "https://realtime.oxylabs.io/v1/queries").trim()
const ENABLED = String(process.env.OXYLABS_WORKER_ENABLED ?? "").trim().toLowerCase() === "true"
const DB_PATH = String(process.env.OXYLABS_LOCAL_DB_PATH ?? join(__dirname, "oxylabs-worker.sqlite"))

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("oxylabs-verify-worker.mjs")) {
  if (!API || TOKEN.length < 32) {
    console.error("[oxylabs-worker] LISTJETGO_API_BASE and OXYLABS_VERIFY_WORKER_TOKEN (>=32) required")
    process.exit(1)
  }
  if (SOURCE !== "amazon_product") {
    console.error("[oxylabs-worker] only amazon_product is allowed")
    process.exit(1)
  }
  if (WORKER_ID !== "oxylabs-product-primary-A" && WORKER_ID !== "oxylabs-product-confirm-C") {
    console.error("[oxylabs-worker] unknown worker identity")
    process.exit(1)
  }
}

function b64(name) {
  const raw = String(process.env[name] ?? "").trim()
  if (!raw) return ""
  return Buffer.from(raw, "base64").toString("utf8")
}

const db = ENABLED || process.env.OXYLABS_LOCAL_DB_PATH ? new DatabaseSync(DB_PATH) : null
if (db) migrateOxylabsWorkerLedger(db)

const ownedCalls = new Set()
let lastCallAt = null
let lastHttpClass = null
let successCount = 0
let busy = false

function telemetry() {
  return {
    version: VERSION,
    role: ROLE,
    slot: SLOT,
    lastCallAt,
    lastHttpClass,
    successCount,
    localPendingResults: db ? pendingOutbox(db).length : 0,
    rss: process.memoryUsage().rss,
    host: hostname(),
  }
}

async function api(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

function stripSecrets(obj) {
  const clone = JSON.parse(JSON.stringify(obj))
  delete clone.username
  delete clone.password
  delete clone.authorization
  if (clone.job && typeof clone.job === "object") {
    delete clone.job.username
    delete clone.job.password
    delete clone.job.headers
  }
  return clone
}

function acked(status) {
  return (status >= 200 && status < 300) || status === 409
}

async function submitResult(row) {
  const payload = JSON.parse(row.response_json)
  const r = await api("/internal/oxylabs-verify/result", {
    workerId: WORKER_ID,
    jobId: row.job_id,
    leaseToken: row.lease_token,
    source: SOURCE,
    geoLocation: GEO,
    observedAt: new Date().toISOString(),
    payload,
    callOutcome: row.call_outcome,
    httpStatus: row.http_status,
  })
  return { acked: acked(r.status), status: r.status }
}

async function submitFail(row) {
  const r = await api("/internal/oxylabs-verify/fail", {
    workerId: WORKER_ID,
    jobId: row.job_id,
    leaseToken: row.lease_token,
    code: row.fail_code || "OXYLABS_CALL_OUTCOME_UNKNOWN",
    message: String(row.fail_message ?? "fail").slice(0, 500),
  })
  return { acked: acked(r.status), status: r.status }
}

async function callOxylabsOnce(asin) {
  const user = b64("OXYLABS_API_USERNAME_B64")
  const pass = b64("OXYLABS_API_PASSWORD_B64")
  const auth = Buffer.from(`${user}:${pass}`).toString("base64")
  const res = await fetch(OXY_BASE, {
    method: "POST",
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      source: "amazon_product",
      query: asin,
      geo_location: GEO,
      parse: PARSE,
    }),
  })
  const json = await res.json().catch(() => ({}))
  return { httpStatus: res.status, json: stripSecrets(json) }
}

async function drainOutbox() {
  if (!db) return
  for (const row of pendingOutbox(db)) {
    if (row.response_json && row.result_submitted !== 1) {
      bumpResultSubmitAttempt(db, row.job_id)
      const r = await submitResult(row)
      if (r.acked) markResultSubmitted(db, row.job_id)
    } else if (row.fail_code && row.fail_submitted !== 1) {
      bumpFailSubmitAttempt(db, row.job_id)
      const r = await submitFail(row)
      if (r.acked) markFailSubmitted(db, row.job_id)
    }
  }
}

async function loop() {
  if (!ENABLED) {
    console.log("[oxylabs-worker] OXYLABS_WORKER_ENABLED=false idle")
    return
  }
  if (busy || !db) return
  busy = true
  try {
    await api("/internal/oxylabs-verify/heartbeat", {
      workerId: WORKER_ID,
      status: "ONLINE",
      hostTelemetry: telemetry(),
    })
    const claim = await api("/internal/oxylabs-verify/claim-next", {
      workerId: WORKER_ID,
      preferConfirm: false,
    })
    const job = claim.json?.job
    if (job?.jobId) {
      const out = await processClaimedJob({
        db,
        job,
        expiredRecovery: job.expiredRecovery === true,
        ownedCalls,
        callProvider: async asin => {
          const r = await callOxylabsOnce(asin)
          lastCallAt = new Date().toISOString()
          lastHttpClass = r.httpStatus >= 500 ? "5xx" : r.httpStatus >= 400 ? "4xx" : r.httpStatus >= 200 ? "2xx" : "other"
          if (r.httpStatus >= 200 && r.httpStatus < 300) successCount += 1
          return r
        },
        submitResult,
        submitFail,
      })
      void loadJob
      void out
    }
    await drainOutbox()
  } catch (e) {
    console.warn("[oxylabs-worker]", e instanceof Error ? e.message : "error")
  } finally {
    busy = false
  }
}

const isMain =
  Boolean(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) ||
  String(process.argv[1] ?? "").endsWith("oxylabs-verify-worker.mjs")

if (isMain) {
  console.log(`[oxylabs-worker] version=${VERSION} role=${ROLE} slot=${SLOT} enabled=${ENABLED} source=${SOURCE}`)
  if (String(process.env.OXYLABS_PRICING_ENABLED ?? "").trim().toLowerCase() === "true") process.exit(1)
  void loop()
  setInterval(() => {
    void loop()
  }, POLL_MS)
}
