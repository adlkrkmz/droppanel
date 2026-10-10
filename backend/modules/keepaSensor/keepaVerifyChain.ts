import { query } from "../../db/client"
import { loadAmazonScanConfig } from "../amazonScan/amazonScanConfig"
import { enqueueScanJob } from "../amazonScan/amazonScanJobQueue"
import { isScanObservationIncomplete } from "../amazonScan/amazonScanApplyPolicy"
import { classifyVerifiedAmazonSource } from "../amazonVerification/verifiedSourceDecision"
import {
  decideKeepaVerifyFollowUp,
  keepaVerifyCandidatePurpose,
  keepaVerifyPrimaryEnqueueSkip,
  KEEPA_TRUSTED_BASELINE_PURPOSE,
} from "./keepaVerifyChainPolicy"

export {
  KEEPA_TRUSTED_BASELINE_PURPOSE,
  KEEPA_VERIFY_PRIMARY_ACTIVE_CAP,
  KEEPA_VERIFY_PRIMARY_CODES,
  decideKeepaVerifyFollowUp,
  isKeepaVerifyCandidateTerminal,
  keepaVerifyCandidatePurpose,
  keepaVerifyConfirmPersistMode,
  keepaVerifyPrimaryEnqueueSkip,
  keepaVerifyPrimaryEnqueueSlots,
  shouldEnqueueKeepaVerifyPrimary,
} from "./keepaVerifyChainPolicy"
export type { KeepaVerifyFollowUp, KeepaVerifyPrimaryCode } from "./keepaVerifyChainPolicy"

const ACTIVE_JOB = ["PENDING", "CLAIMED", "RUNNING", "WAITING_FOR_WORKER", "RETRYABLE"]

export async function enqueueKeepaVerifyPrimaryForCandidate(input: {
  asin: string
  candidateId: string | number
  evaluationCode: string
}): Promise<{ jobId: number; created: boolean; skipped: string | null }> {
  const cfg = loadAmazonScanConfig()
  const candidateId = Number(input.candidateId)
  if (!Number.isFinite(candidateId) || candidateId <= 0) {
    return { jobId: 0, created: false, skipped: "CANDIDATE_MISSING" }
  }
  const cand = await query<{ status: string; snapshot: Record<string, unknown> | null }>(
    `SELECT status, snapshot FROM keepa_verify_candidates WHERE id = $1::bigint`,
    [candidateId]
  )
  const existing = await query<{ id: string; status: string }>(
    `SELECT id::text, status FROM amazon_scan_jobs
     WHERE keepa_candidate_id = $1::bigint AND kind = 'KEEPA_VERIFY_PRIMARY'
       AND status = ANY($2::text[])
     ORDER BY id DESC LIMIT 1`,
    [candidateId, ACTIVE_JOB]
  )
  const active = await query<{ id: string }>(
    `SELECT id::text FROM amazon_scan_jobs
     WHERE keepa_candidate_id = $1::bigint
       AND kind IN ('KEEPA_VERIFY_PRIMARY','KEEPA_VERIFY_CONFIRM')
       AND status = ANY($2::text[])
     LIMIT 1`,
    [candidateId, ACTIVE_JOB]
  )
  const asin = input.asin.trim().toUpperCase()
  const duplicateAsin = await query<{ id: string }>(
    `SELECT id::text FROM amazon_scan_jobs
     WHERE asin = $1 AND kind = 'KEEPA_VERIFY_PRIMARY' AND status = ANY($2::text[])
     LIMIT 1`,
    [asin, ACTIVE_JOB]
  )
  const purpose = keepaVerifyCandidatePurpose(
    String(cand.rows[0]?.snapshot?.evaluationCode ?? input.evaluationCode)
  )
  let trustedBaselineAlreadyExists = false
  if (purpose === KEEPA_TRUSTED_BASELINE_PURPOSE) {
    const { loadTrustedAmazonReference } = await import("./keepaTrustedReference")
    const trusted = await loadTrustedAmazonReference(asin)
    const matchedBaseline = await query<{ id: string }>(
      `SELECT id::text FROM keepa_verify_candidates
       WHERE asin = $1 AND status = 'MATCHED'
         AND UPPER(COALESCE(snapshot->>'purpose', '')) = $2
       LIMIT 1`,
      [asin, KEEPA_TRUSTED_BASELINE_PURPOSE]
    )
    trustedBaselineAlreadyExists = Boolean(trusted) || Boolean(matchedBaseline.rows[0])
  }
  const skip = keepaVerifyPrimaryEnqueueSkip({
    enqueueEnabled: cfg.keepaVerifyEnqueueEnabled,
    evaluationCode: input.evaluationCode,
    candidateStatus: cand.rows[0]?.status ?? null,
    existingPrimary: Boolean(existing.rows[0]),
    activeJob: Boolean(active.rows[0]),
    duplicateAsinActive: Boolean(duplicateAsin.rows[0]),
    trustedBaselineAlreadyExists,
  })
  if (skip === "PRIMARY_EXISTS" && existing.rows[0]) {
    return { jobId: Number(existing.rows[0].id), created: false, skipped: skip }
  }
  if (skip === "ACTIVE_JOB_EXISTS" && active.rows[0]) {
    return { jobId: Number(active.rows[0].id), created: false, skipped: skip }
  }
  if (skip) {
    return { jobId: 0, created: false, skipped: skip }
  }
  const g = await query<{ id: string }>(
    `SELECT id::text FROM global_amazon_asins WHERE asin = $1 ORDER BY id ASC LIMIT 1`,
    [asin]
  )
  if (!g.rows[0]) return { jobId: 0, created: false, skipped: "GLOBAL_ASIN_MISSING" }
  const enq = await enqueueScanJob({
    globalAsinId: Number(g.rows[0].id),
    asin,
    marketplace: cfg.marketplace,
    deliveryZip: cfg.deliveryZip,
    sessionClass: cfg.sessionClass,
    kind: "KEEPA_VERIFY_PRIMARY",
    priority: 0,
    requireFreshNav: true,
    keepaCandidateId: candidateId,
  })
  return { jobId: enq.jobId, created: enq.created, skipped: enq.created ? null : "PRIMARY_NOT_CREATED" }
}

export async function enqueueKeepaVerifyConfirmFromPrimary(input: {
  parentJobId: number
  globalAsinId: number
  asin: string
  marketplace: string
  deliveryZip: string
  sessionClass: string
  keepaCandidateId: number | null
  payload: Record<string, unknown>
}): Promise<{ jobId: number; created: boolean; skipped: string | null }> {
  if (isScanObservationIncomplete(input.payload)) {
    return { jobId: 0, created: false, skipped: "PRIMARY_INCOMPLETE" }
  }
  const decision = classifyVerifiedAmazonSource({
    requestedAsin: input.asin,
    finalAsin: input.payload.finalAsin,
    displayedPrice: typeof input.payload.displayedPrice === "number" ? input.payload.displayedPrice : null,
    condition: typeof input.payload.condition === "string" ? input.payload.condition : null,
    isPrime: typeof input.payload.isPrime === "boolean" ? input.payload.isPrime : null,
    isFba: typeof input.payload.isFba === "boolean" ? input.payload.isFba : null,
    shipsFromAmazon: typeof input.payload.shipsFromAmazon === "boolean" ? input.payload.shipsFromAmazon : null,
    purchasable:
      input.payload.purchasable === "TRUE" || input.payload.purchasable === "FALSE" || input.payload.purchasable === "UNKNOWN"
        ? input.payload.purchasable
        : null,
    stockStatus: typeof input.payload.stockStatus === "string" ? input.payload.stockStatus : null,
    availabilityText: typeof input.payload.availabilityText === "string" ? input.payload.availabilityText : null,
    pageUnavailable: input.payload.pageUnavailable === true,
    redirected: input.payload.redirected === true,
    captcha: input.payload.captcha === true,
    timeout: input.payload.timeout === true,
    uncertain: input.payload.uncertain === true,
    offerPageHealthy: input.payload.offerPageHealthy === true,
  })
  const follow = decideKeepaVerifyFollowUp({
    kind: "KEEPA_VERIFY_PRIMARY",
    incomplete: false,
    decisionOutcome: decision.outcome,
    fingerprintMatch: false,
    freshnessSkip: null,
  })
  if (!follow.enqueueConfirm) {
    return { jobId: 0, created: false, skipped: follow.reason }
  }
  const existingConfirm = await query<{ id: string }>(
    `SELECT id::text FROM amazon_scan_jobs
     WHERE parent_job_id = $1::bigint AND kind = 'KEEPA_VERIFY_CONFIRM'
       AND status NOT IN ('FAILED','CANCELLED')
     ORDER BY id DESC LIMIT 1`,
    [input.parentJobId]
  )
  if (existingConfirm.rows[0]) {
    return { jobId: Number(existingConfirm.rows[0].id), created: false, skipped: "CONFIRM_EXISTS" }
  }
  const enq = await enqueueScanJob({
    globalAsinId: input.globalAsinId,
    asin: input.asin,
    marketplace: input.marketplace,
    deliveryZip: input.deliveryZip,
    sessionClass: input.sessionClass,
    kind: "KEEPA_VERIFY_CONFIRM",
    priority: 0,
    parentJobId: input.parentJobId,
    requireFreshNav: true,
    keepaCandidateId: input.keepaCandidateId,
  })
  return { jobId: enq.jobId, created: enq.created, skipped: enq.created ? null : "CONFIRM_EXISTS" }
}

export async function markKeepaVerifyCandidateStatus(
  candidateId: number | null,
  status: "MATCHED" | "CONFLICT" | "RETRYABLE" | "INCONCLUSIVE" | "NO_BUSINESS_CHANGE" | "SUPERSEDED" | "PENDING"
): Promise<void> {
  if (candidateId == null || !Number.isFinite(candidateId) || candidateId <= 0) return
  await query(
    `UPDATE keepa_verify_candidates
     SET status = $2, browser_decision = $2, updated_at = NOW()
     WHERE id = $1::bigint AND status IN ('PENDING','RETRYABLE','INCONCLUSIVE')`,
    [candidateId, status]
  )
}
