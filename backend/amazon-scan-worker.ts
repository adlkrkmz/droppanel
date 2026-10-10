import "dotenv/config"
import fs from "fs"
import path from "path"
import { AmazonPublicWorker } from "./modules/amazonPublicWorker/amazonPublicWorker"
import { mapPublicObservationToVerificationPayload } from "./modules/amazonPublicWorker/mapPublicObservationToVerificationPayload"
import { amazonScanWorkerPaceMs, amazonScanWorkerIdForRole, resolvePublicWorkerIdentity } from "./modules/amazonPublicWorker/amazonPublicWorkerPool"
import { amazonPublicObserveHardTimeoutMs } from "./modules/amazonBrowserWorker/amazonBrowserWorkerConstants"
import { collectAmazonScanHostTelemetry } from "./modules/amazonScan/amazonScanHostTelemetry"
import { AMAZON_SCAN_WORKER_VERSION } from "./modules/amazonPublicWorker/amazonScanWorkerVersion"

delete process.env.DATABASE_URL
delete process.env.EBAY_CLIENT_ID
delete process.env.EBAY_CLIENT_SECRET
delete process.env.EBAY_REFRESH_TOKEN

const API = (process.env.AMAZON_SCAN_API_BASE ?? "").replace(/\/$/, "")
const TOKEN = (process.env.AMAZON_SCAN_WORKER_TOKEN ?? "").trim()

if (!API || TOKEN.length < 32) {
  console.error("[amazon-scan-worker] AMAZON_SCAN_API_BASE and AMAZON_SCAN_WORKER_TOKEN (>=32) required; no DATABASE_URL")
  process.exit(1)
}

const identity = resolvePublicWorkerIdentity()
const workerRole = String(process.env.AMAZON_SCAN_WORKER_ROLE ?? "ROUTINE").toUpperCase()
const preferConfirm = workerRole === "CONFIRM" || workerRole === "KEEPA_VERIFY_CONFIRM"
const workerId = amazonScanWorkerIdForRole(workerRole, identity.slot)
const OUTBOX = path.join(process.cwd(), "var", `amazon-scan-local-outbox-${identity.slot}.jsonl`)
const FETCH_MS = 12_000
const paceMs = amazonScanWorkerPaceMs(identity.slot)

type Job = {
  jobId: number
  asin: string
  leaseToken: string
  requireFreshNavigation?: boolean
}

let currentJob: Job | null = null
let leaseLost = false

function safeErr(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/Bearer\s+\S+/gi, "Bearer ***").slice(0, 180)
}

async function api(pathName: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), FETCH_MS)
  try {
    const res = await fetch(`${API}${pathName}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const errCode = typeof json.error === "string" ? json.error : ""
      throw new Error(`HTTP ${res.status}${errCode ? ` ${errCode}` : ""}`)
    }
    return json
  } finally {
    clearTimeout(t)
  }
}

function appendOutbox(row: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(OUTBOX), { recursive: true })
  fs.appendFileSync(OUTBOX, JSON.stringify(row) + "\n")
}

async function flushOutbox(): Promise<void> {
  if (!fs.existsSync(OUTBOX)) return
  const lines = fs.readFileSync(OUTBOX, "utf8").split("\n").filter(Boolean)
  const keep: string[] = []
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      await api(String(row.path), (row.body ?? {}) as Record<string, unknown>)
    } catch (e) {
      const msg = safeErr(e)
      if (/STALE_LEASE|HTTP 409/.test(msg)) continue
      keep.push(line)
    }
  }
  fs.writeFileSync(OUTBOX, keep.length ? keep.join("\n") + "\n" : "")
}

async function deliver(pathName: string, body: Record<string, unknown>): Promise<void> {
  if (leaseLost) {
    console.warn(`[amazon-scan-worker] skip ${pathName} job=${body.jobId} stale_lease`)
    return
  }
  try {
    await api(pathName, body)
  } catch (e) {
    const msg = safeErr(e)
    console.warn(`[amazon-scan-worker] ${pathName} failed: ${msg}`)
    if (/STALE_LEASE|HTTP 409/.test(msg)) {
      leaseLost = true
      return
    }
    appendOutbox({ path: pathName, body })
  }
}

async function observe(asin: string, fresh: boolean, job: Job) {
  const worker = new AmazonPublicWorker(identity.browserName, {
    localPort: 0,
    keepaConcurrency: 1,
    amazonMode: "FAILOVER",
    amazonWorkers: [identity.browserName],
    amazonActiveConcurrency: 1,
    amazonHeadless: true,
    navigationTimeout: 45000,
    keepaHeadless: true,
    keepaDelayMs: 1500,
    amazonDelayMs: 2500,
    technicalRetryMax: 1,
  }, { profileDir: identity.profileDir })
  const hardMs = amazonPublicObserveHardTimeoutMs()
  let timedOut = false
  const hardTimer = setTimeout(() => {
    timedOut = true
    void worker.abortOwnedBrowser("HARD_TIMEOUT")
  }, hardMs)
  const leaseTimer = setInterval(() => {
    void api("/internal/amazon-scan/lease-renew", {
      workerId,
      jobId: job.jobId,
      leaseToken: job.leaseToken,
    })
      .then(json => {
        if (json.ok === false) {
          leaseLost = true
          console.warn(`[amazon-scan-worker] lease-renew rejected job=${job.jobId}`)
        }
      })
      .catch(e => {
        const msg = safeErr(e)
        console.warn(`[amazon-scan-worker] lease-renew failed: ${msg}`)
        if (/HTTP 409|STALE_LEASE/.test(msg)) leaseLost = true
      })
  }, 30000)
  try {
    if (fresh) {
      await worker.open()
      await worker.close("FRESH")
    }
    const result = await Promise.race([
      worker.observe(asin),
      new Promise<Awaited<ReturnType<typeof worker.observe>>>(resolve =>
        setTimeout(
          () => resolve({ kind: "technical", reason: `OBSERVE_HARD_TIMEOUT after ${hardMs}ms` }),
          hardMs
        )
      ),
    ])
    if (timedOut || (result.kind === "technical" && /OBSERVE_HARD_TIMEOUT/.test(result.reason ?? ""))) {
      return { kind: "incomplete_timeout" as const, reason: result.reason ?? `OBSERVE_HARD_TIMEOUT after ${hardMs}ms` }
    }
    return result
  } finally {
    clearTimeout(hardTimer)
    clearInterval(leaseTimer)
    await worker.abortOwnedBrowser().catch(() => undefined)
  }
}

async function processOne(): Promise<boolean> {
  await flushOutbox()
  const claimed = await api("/internal/amazon-scan/claim-next", { workerId, preferConfirm })
  const job = claimed.job as Job | null
  if (!job) {
    currentJob = null
    return false
  }
  currentJob = job
  leaseLost = false
  const running = await api("/internal/amazon-scan/running", {
    workerId,
    jobId: job.jobId,
    leaseToken: job.leaseToken,
  }).catch(e => {
    console.warn(`[amazon-scan-worker] running failed: ${safeErr(e)}`)
    return { ok: false }
  })
  if (running.ok === false) {
    leaseLost = true
    currentJob = null
    return true
  }
  const result = await observe(job.asin, job.requireFreshNavigation === true, job)
  if (leaseLost) {
    console.warn(`[amazon-scan-worker] skip result job=${job.jobId} stale_lease`)
    currentJob = null
    return true
  }
  if (result.kind === "incomplete_timeout") {
    await deliver("/internal/amazon-scan/fail", {
      workerId,
      jobId: job.jobId,
      leaseToken: job.leaseToken,
      code: "AMAZON_INCOMPLETE",
      message: result.reason ?? "OBSERVE_HARD_TIMEOUT",
    })
    currentJob = null
    return true
  }
  if (result.kind === "challenge") {
    await deliver("/internal/amazon-scan/fail", {
      workerId,
      jobId: job.jobId,
      leaseToken: job.leaseToken,
      code: "CAPTCHA",
      message: result.reason ?? "challenge",
    })
    currentJob = null
    return true
  }
  if (result.kind === "technical") {
    await deliver("/internal/amazon-scan/fail", {
      workerId,
      jobId: job.jobId,
      leaseToken: job.leaseToken,
      code: "WORKER_ERROR",
      message: result.reason ?? "technical",
    })
    currentJob = null
    return true
  }
  const mapped = mapPublicObservationToVerificationPayload({
    requestedAsin: job.asin,
    observation: result.observation!,
    publicStatus: result.status ?? "AMAZON_INCOMPLETE",
  })
  await deliver("/internal/amazon-scan/result", {
    workerId,
    jobId: job.jobId,
    leaseToken: job.leaseToken,
    observedAt: new Date().toISOString(),
    payload: mapped.payload,
  })
  currentJob = null
  return true
}

async function main(): Promise<void> {
  console.log(
    `[amazon-scan-worker] version=${AMAZON_SCAN_WORKER_VERSION} slot=${identity.slot} role=${workerRole} workerId=${workerId} api=${API} confirm=${preferConfirm} paceMs=${paceMs}`
  )
  setInterval(() => {
    void api("/internal/amazon-scan/heartbeat", {
      workerId,
      status: "ONLINE",
      browserRunning: true,
      currentJobId: currentJob?.jobId ?? null,
      hostTelemetry: collectAmazonScanHostTelemetry(),
    }).catch(e => {
      console.warn(`[amazon-scan-worker] heartbeat failed: ${safeErr(e)}`)
    })
  }, 15000)
  while (true) {
    try {
      const did = await processOne()
      await new Promise(r => setTimeout(r, did ? paceMs : Math.min(3000, paceMs)))
    } catch (e) {
      console.error("[amazon-scan-worker]", safeErr(e))
      currentJob = null
      await new Promise(r => setTimeout(r, paceMs))
    }
  }
}

void main()
