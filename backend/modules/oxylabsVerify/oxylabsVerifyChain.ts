import { query } from "../../db/client"
import { loadAmazonScanConfig } from "../amazonScan/amazonScanConfig"
import { shouldEnqueueKeepaVerifyPrimary } from "../keepaSensor/keepaVerifyChainPolicy"
import { loadOxylabsVerifyConfig } from "./oxylabsVerifyConfig"
import { OXYLABS_PRODUCT_PRIMARY } from "./oxylabsVerifyKinds"
import { enqueueOxylabsScanJob } from "./oxylabsVerifyJobQueue"
import { loadOxylabsPlanUsage } from "./oxylabsPlanUsage"

const ACTIVE = ["PENDING", "CLAIMED", "RUNNING", "WAITING_FOR_WORKER", "RETRYABLE"]

export async function enqueueOxylabsProductPrimaryForCandidate(input: {
  asin: string
  candidateId: string | number
  evaluationCode: string
}): Promise<{ jobId: number; created: boolean; skipped: string | null }> {
  const oxy = loadOxylabsVerifyConfig()
  const cfg = loadAmazonScanConfig()
  if (!oxy.enqueueEnabled) return { jobId: 0, created: false, skipped: "OXYLABS_VERIFY_ENQUEUE_DISABLED" }
  if (!shouldEnqueueKeepaVerifyPrimary(input.evaluationCode)) {
    return { jobId: 0, created: false, skipped: "CODE_NOT_PRIMARY" }
  }
  const candidateId = Number(input.candidateId)
  if (!Number.isFinite(candidateId) || candidateId <= 0) {
    return { jobId: 0, created: false, skipped: "CANDIDATE_MISSING" }
  }
  const cand = await query<{ status: string; fingerprint: string }>(
    `SELECT status, fingerprint FROM keepa_verify_candidates WHERE id = $1::bigint`,
    [candidateId]
  )
  const st = String(cand.rows[0]?.status ?? "")
  if (!cand.rows[0]) return { jobId: 0, created: false, skipped: "CANDIDATE_MISSING" }
  if (st === "RETRYABLE" || st === "INCONCLUSIVE") {
    return { jobId: 0, created: false, skipped: "CANDIDATE_NOT_NATURAL_DIFF" }
  }
  if (st !== "PENDING") return { jobId: 0, created: false, skipped: "CANDIDATE_NOT_PENDING" }
  const existing = await query<{ id: string }>(
    `SELECT id::text FROM amazon_scan_jobs
     WHERE keepa_candidate_id = $1::bigint AND kind = $2
       AND status = ANY($3::text[])
     LIMIT 1`,
    [candidateId, OXYLABS_PRODUCT_PRIMARY, ACTIVE]
  )
  if (existing.rows[0]) return { jobId: Number(existing.rows[0].id), created: false, skipped: "PRIMARY_EXISTS" }
  const completed = await query<{ id: string }>(
    `SELECT id::text FROM amazon_scan_jobs
     WHERE keepa_candidate_id = $1::bigint AND kind = $2 AND status = 'COMPLETED'
     LIMIT 1`,
    [candidateId, OXYLABS_PRODUCT_PRIMARY]
  )
  if (completed.rows[0]) return { jobId: Number(completed.rows[0].id), created: false, skipped: "PRIMARY_ALREADY_COMPLETED" }
  const failed = await query<{ id: string }>(
    `SELECT id::text FROM amazon_scan_jobs
     WHERE keepa_candidate_id = $1::bigint AND kind = $2 AND status = 'FAILED'
     LIMIT 1`,
    [candidateId, OXYLABS_PRODUCT_PRIMARY]
  )
  if (failed.rows[0]) return { jobId: 0, created: false, skipped: "OXYLABS_CALL_FAILED_TERMINAL" }
  const asin = input.asin.trim().toUpperCase()
  const dupAsin = await query<{ id: string }>(
    `SELECT id::text FROM amazon_scan_jobs
     WHERE asin = $1 AND kind = $2 AND status = ANY($3::text[])
     LIMIT 1`,
    [asin, OXYLABS_PRODUCT_PRIMARY, ACTIVE]
  )
  if (dupAsin.rows[0]) return { jobId: Number(dupAsin.rows[0].id), created: false, skipped: "DUPLICATE_ASIN" }
  const g = await query<{ id: string }>(
    `SELECT id::text FROM global_amazon_asins WHERE asin = $1 ORDER BY id ASC LIMIT 1`,
    [asin]
  )
  if (!g.rows[0]) return { jobId: 0, created: false, skipped: "GLOBAL_ASIN_MISSING" }
  const enq = await enqueueOxylabsScanJob({
    globalAsinId: Number(g.rows[0].id),
    asin,
    marketplace: cfg.marketplace,
    kind: OXYLABS_PRODUCT_PRIMARY,
    keepaCandidateId: candidateId,
  })
  return { jobId: enq.jobId, created: enq.created, skipped: enq.created ? null : "PRIMARY_NOT_CREATED" }
}

export async function oxylabsPrimaryEnqueueSlots(): Promise<number> {
  const usage = await loadOxylabsPlanUsage()
  return usage.remaining
}

export async function feedOxylabsProductPrimaryOrphans(): Promise<{ slots: number; enqueued: number; skipped: number }> {
  const oxy = loadOxylabsVerifyConfig()
  if (!oxy.enqueueEnabled) return { slots: 0, enqueued: 0, skipped: 0 }
  const slots = await oxylabsPrimaryEnqueueSlots()
  if (slots <= 0) return { slots: 0, enqueued: 0, skipped: 0 }
  const orphans = await query<{ id: string; asin: string; evaluation_code: string | null }>(
    `SELECT c.id::text, c.asin, c.snapshot->>'evaluationCode' AS evaluation_code
     FROM keepa_verify_candidates c
     WHERE c.status = 'PENDING'
       AND COALESCE(c.snapshot->>'evaluationCode','') IN (
         'KEEPA_SNAPSHOT_CHANGED', 'BASELINE_PRICE_MISMATCH', 'CONFIRMED_PRICE_MISMATCH',
         'KEEPA_IDENTITY_SUSPECT', 'KEEPA_REQUESTED_ASIN_MISSING',
         'KEEPA_UNVERIFIED_SUSPICIOUS_STATE'
       )
       AND NOT EXISTS (
         SELECT 1 FROM amazon_scan_jobs j
         WHERE j.keepa_candidate_id = c.id
           AND j.kind = 'OXYLABS_PRODUCT_PRIMARY'
           AND j.status = ANY($2::text[])
       )
       AND NOT EXISTS (
         SELECT 1 FROM amazon_scan_jobs j
         WHERE j.keepa_candidate_id = c.id
           AND j.kind = 'OXYLABS_PRODUCT_PRIMARY'
           AND j.status IN ('COMPLETED','FAILED')
       )
       AND NOT EXISTS (
         SELECT 1 FROM amazon_scan_jobs j
         WHERE j.asin = c.asin
           AND j.kind = 'OXYLABS_PRODUCT_PRIMARY'
           AND j.status = ANY($2::text[])
       )
     ORDER BY c.created_at ASC
     LIMIT $1`,
    [slots, ACTIVE]
  )
  let enqueued = 0
  let skipped = 0
  for (const row of orphans.rows) {
    const result = await enqueueOxylabsProductPrimaryForCandidate({
      asin: row.asin,
      candidateId: row.id,
      evaluationCode: String(row.evaluation_code ?? ""),
    })
    if (result.created) enqueued++
    else skipped++
  }
  return { slots, enqueued, skipped }
}

let timer: NodeJS.Timeout | null = null
let running = false

export function startOxylabsVerifyPrimaryFeeder(): void {
  const oxy = loadOxylabsVerifyConfig()
  if (!oxy.enqueueEnabled) {
    console.log("[OxylabsVerifyPrimaryFeeder] disabled")
    return
  }
  if (timer) return
  timer = setInterval(() => {
    if (running) return
    running = true
    void feedOxylabsProductPrimaryOrphans()
      .catch(e => console.warn("[OxylabsVerifyPrimaryFeeder]", e instanceof Error ? e.message : String(e)))
      .finally(() => {
        running = false
      })
  }, 2000)
  console.log(
    `[OxylabsVerify] protocol=${oxy.protocolEnabled} enqueue=${oxy.enqueueEnabled} claim=${oxy.claimEnabled} applyProcessor=${oxy.applyProcessorEnabled} mutations=${oxy.mutationsEnabled} planMode=${oxy.planMode} monthlyLimit=${oxy.monthlyResultLimit} canaryMax=${oxy.canaryMaxSuccessResults}`
  )
  console.log("[OxylabsVerifyPrimaryFeeder] started")
}
