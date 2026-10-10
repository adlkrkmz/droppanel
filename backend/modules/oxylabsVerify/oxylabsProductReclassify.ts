import { query } from "../../db/client"
import { markKeepaVerifyCandidateStatus } from "../keepaSensor/keepaVerifyChain"
import { loadOxylabsVerifyConfig } from "./oxylabsVerifyConfig"
import { OXYLABS_PRODUCT_CONFIRM, OXYLABS_PRODUCT_PRIMARY } from "./oxylabsVerifyKinds"
import { normalizeOxylabsAmazonProduct } from "./oxylabsProductNormalize"
import {
  decideOxylabsSingleQuery,
  OXYLABS_SINGLE_QUERY_POLICY,
  type OxylabsPanelListing,
} from "./oxylabsProductDecision"
import { resolveApplySourceAsin } from "../monitor/listingAsinResolve"
import { isListingLiveForV2 } from "../globalKeepa/sourceAsinLifecycle"

const ACTIVE_CONFIRM = ["PENDING", "CLAIMED", "RUNNING", "WAITING_FOR_WORKER", "RETRYABLE"]

export async function persistOxylabsPolicyOnJob(jobId: number, policy: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE amazon_scan_jobs
     SET result_payload = COALESCE(result_payload, '{}'::jsonb) || jsonb_build_object('oxylabs_policy', $2::jsonb),
         updated_at = NOW()
     WHERE id = $1::bigint`,
    [jobId, JSON.stringify(policy)]
  )
}

export async function supersedeOxylabsConfirmJobs(): Promise<number> {
  const upd = await query<{ id: string }>(
    `UPDATE amazon_scan_jobs
     SET status = 'CANCELLED',
         failure_code = $1,
         failure_message = $1,
         updated_at = NOW()
     WHERE kind = $2
       AND status = ANY($3::text[])
     RETURNING id::text`,
    [OXYLABS_SINGLE_QUERY_POLICY, OXYLABS_PRODUCT_CONFIRM, ACTIVE_CONFIRM]
  )
  return upd.rows.length
}

export async function evaluateStoredOxylabsPrimaryJob(primaryJobId: number): Promise<{
  jobId: number
  code: string
  audit: string
  enqueueConfirm: false
}> {
  const row = await query<{
    kind: string
    asin: string
    keepa_candidate_id: string | null
    result_payload: Record<string, unknown> | null
    global_asin_id: string
  }>(
    `SELECT kind, asin, keepa_candidate_id::text, result_payload, global_asin_id::text
     FROM amazon_scan_jobs WHERE id = $1::bigint`,
    [primaryJobId]
  )
  const job = row.rows[0]
  if (!job || job.kind !== OXYLABS_PRODUCT_PRIMARY || !job.result_payload) {
    return { jobId: primaryJobId, code: "JOB_MISSING", audit: "PRODUCT_INCONCLUSIVE", enqueueConfirm: false }
  }
  const n = normalizeOxylabsAmazonProduct({
    requestedAsin: job.asin,
    payload: job.result_payload,
    geoLocation: loadOxylabsVerifyConfig().geoLocation,
  })
  const cat = await query<{
    source_price: string | null
    current_status: string | null
    ebay_quantity: string | null
    registry_asin: string | null
    source_url: string | null
    internal_sku: string | null
  }>(
    `SELECT scs.source_price::text, scs.current_status::text, scs.ebay_quantity::text,
            ar.asin AS registry_asin, scs.source_url, scs.internal_sku
     FROM global_asin_consumers c
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     LEFT JOIN asin_registry ar ON ar.id = scs.asin_registry_id
     WHERE c.global_asin_id = $1::bigint
     ORDER BY scs.updated_at DESC NULLS LAST
     LIMIT 1`,
    [Number(job.global_asin_id)]
  )
  const c = cat.rows[0]
  const panel: OxylabsPanelListing | null = c
    ? {
        sourceAsin: resolveApplySourceAsin({
          registryAsin: c.registry_asin,
          sourceUrl: c.source_url,
          internalSku: c.internal_sku?.trim() ?? "",
          consumerAsin: job.asin,
        }),
        sourcePrice: c.source_price != null ? Number(c.source_price) : null,
        listingLive: isListingLiveForV2(c.current_status),
        qty: c.ebay_quantity != null ? Number(c.ebay_quantity) : 0,
      }
    : null
  const d = decideOxylabsSingleQuery({
    n,
    panel,
    mutationsEnabled: loadOxylabsVerifyConfig().mutationsEnabled,
  })
  await persistOxylabsPolicyOnJob(primaryJobId, {
    version: 4,
    productClass: d.productClass,
    code: d.code,
    evidenceCode: d.evidenceCode,
    enqueueConfirm: false,
    followReason: d.audit,
    evaluatedAt: new Date().toISOString(),
    primeEvidence: n.primeEvidence,
    primeEligible: n.isPrimeEligible,
    primeEvidenceStrength: n.primeEvidenceStrength,
    panelSourcePrice: panel?.sourcePrice ?? null,
    oxylabsPrice: n.pricePositive,
    stockClass: n.stockClass,
    afn: n.isAmazonFulfilled,
    shipsFromAmazon: n.shipsFromAmazon,
  })
  if (d.productClass === "PRODUCT_INCONCLUSIVE" && job.keepa_candidate_id) {
    await markKeepaVerifyCandidateStatus(Number(job.keepa_candidate_id), "INCONCLUSIVE")
  } else if (d.audit === "NO_BUSINESS_CHANGE" && job.keepa_candidate_id) {
    await markKeepaVerifyCandidateStatus(Number(job.keepa_candidate_id), "NO_BUSINESS_CHANGE")
  }
  return { jobId: primaryJobId, code: d.evidenceCode, audit: d.audit, enqueueConfirm: false }
}
