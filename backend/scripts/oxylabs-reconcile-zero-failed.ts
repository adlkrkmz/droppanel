import "dotenv/config"
import { query } from "../db/client"
import { readOxylabsApplyQuantity } from "../modules/oxylabsVerify/oxylabsApplyEbayReadback"
import {
  getOxylabsApplyOperation,
  markOxylabsApplyOperation,
  oxylabsMutationOperationKey,
  runOxylabsGuardedMutation,
  OXYLABS_APPLY_PROVIDER,
} from "../modules/oxylabsVerify/oxylabsApplyOperations"
import { applyConfirmedNoValidSource } from "../modules/stockGuard/confirmedNoValidSourcePipeline"
import { mapOxylabsToVerifiedDecision, decideOxylabsSingleQuery } from "../modules/oxylabsVerify/oxylabsProductDecision"
import { normalizeOxylabsAmazonProduct, oxylabsProductFingerprint } from "../modules/oxylabsVerify/oxylabsProductNormalize"
import { loadOxylabsVerifyConfig } from "../modules/oxylabsVerify/oxylabsVerifyConfig"
import { getScanJob } from "../modules/amazonScan/amazonScanJobQueue"

const ITEMS = ["178379494633", "178420565307", "366642361250", "366600541272"]

async function main(): Promise<void> {
  const listings = await query<{
    catalog_id: string
    workspace_id: string
    ebay_item_id: string
    ebay_quantity: string | null
    bot_zeroed_reason: string | null
    user_id: string | null
    asin: string | null
  }>(
    `SELECT scs.id::text AS catalog_id, scs.workspace_id::text,
            scs.ebay_item_id, scs.ebay_quantity::text, scs.bot_zeroed_reason,
            (
              SELECT wm.user_id::text FROM workspace_members wm
              WHERE wm.workspace_id = scs.workspace_id
              ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, wm.created_at ASC
              LIMIT 1
            ) AS user_id,
            ar.asin
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.ebay_item_id = ANY($1::text[])`,
    [ITEMS]
  )
  const events = await query<{
    catalog_state_id: string
    asin: string | null
    ebay_item_id: string
    event_type: string
    created_at: string
    message: string | null
  }>(
    `SELECT catalog_state_id::text, asin, ebay_item_id, event_type, created_at::text, message
     FROM workspace_activity_events
     WHERE ebay_item_id = ANY($1::text[])
       AND event_type IN ('STOCK_ZEROED','STOCK_ZERO_FAILED')
       AND created_at > TIMESTAMPTZ '2026-09-24 09:54:00+00'
     ORDER BY created_at`,
    [ITEMS]
  )
  const asins = [...new Set(events.rows.map(e => e.asin).filter((a): a is string => Boolean(a)))]
  const jobs = await query<{
    id: string
    asin: string
    keepa_candidate_id: string | null
    code: string | null
  }>(
    `SELECT j.id::text, j.asin, j.keepa_candidate_id::text,
            j.result_payload->'oxylabs_policy'->>'code' AS code
     FROM amazon_scan_jobs j
     WHERE j.kind = 'OXYLABS_PRODUCT_PRIMARY'
       AND j.asin = ANY($1::text[])
       AND j.id > 6940
     ORDER BY j.id`,
    [asins]
  )
  const report = []
  for (const row of listings.rows) {
    const eventAsin = events.rows.find(e => e.ebay_item_id === row.ebay_item_id)?.asin || row.asin
    const matchedJob = jobs.rows.find(j => j.asin === eventAsin) || null
    const jobId = matchedJob ? Number(matchedJob.id) : 0
    const operationKey = jobId
      ? oxylabsMutationOperationKey({
          provider: OXYLABS_APPLY_PROVIDER,
          jobId,
          candidateId: matchedJob?.keepa_candidate_id ? Number(matchedJob.keepa_candidate_id) : 0,
          fingerprint: "reconcile",
          action: "zero_stock",
          target: "qty:0",
          catalogStateId: Number(row.catalog_id),
        })
      : null
    const dbQty = row.ebay_quantity != null ? Number(row.ebay_quantity) : null
    const ebayQty = await readOxylabsApplyQuantity(row.workspace_id, Number(row.catalog_id))
    let action = "none"
    if ((ebayQty === 0 || dbQty === 0) && operationKey && jobId) {
      const existing = await getOxylabsApplyOperation(operationKey)
      if (!existing) {
        await query(
          `INSERT INTO oxylabs_apply_operations (
             operation_key, job_id, catalog_state_id, action, target, status, owner,
             attempt_count, ebay_mutate_count, ebay_readback_count, applied_at, created_at, updated_at
           ) VALUES ($1,$2::bigint,$3::bigint,'zero_stock','qty:0','APPLIED','reconcile',1,0,1,NOW(),NOW(),NOW())
           ON CONFLICT (operation_key) DO UPDATE
             SET status = 'APPLIED', applied_at = COALESCE(oxylabs_apply_operations.applied_at, NOW()),
                 ebay_readback_count = oxylabs_apply_operations.ebay_readback_count + 1,
                 updated_at = NOW()`,
          [operationKey, jobId, Number(row.catalog_id)]
        )
      } else if (existing.status !== "APPLIED") {
        await markOxylabsApplyOperation({ operationKey, status: "APPLIED", bumpReadback: true })
      }
      action = "marked_applied_no_mutation"
    } else if (ebayQty === 1 && jobId && row.user_id) {
      const scan = await getScanJob(jobId)
      const full = await query<{ result_payload: Record<string, unknown> | null }>(
        `SELECT result_payload FROM amazon_scan_jobs WHERE id = $1::bigint`,
        [jobId]
      )
      const payload = full.rows[0]?.result_payload
      if (scan && payload) {
        const oxy = loadOxylabsVerifyConfig()
        const n = normalizeOxylabsAmazonProduct({
          requestedAsin: scan.asin,
          payload,
          geoLocation: oxy.geoLocation,
        })
        const classified = decideOxylabsSingleQuery({ n, panel: null, mutationsEnabled: true })
        const decision = mapOxylabsToVerifiedDecision({
          n,
          productClass: classified.productClass,
          code: classified.evidenceCode,
        })
        const liveKey = oxylabsMutationOperationKey({
          provider: OXYLABS_APPLY_PROVIDER,
          jobId,
          candidateId: scan.keepaCandidateId,
          fingerprint: oxylabsProductFingerprint(n, classified.productClass),
          action: "zero_stock",
          target: "qty:0",
          catalogStateId: Number(row.catalog_id),
        })
        const gated = await runOxylabsGuardedMutation({
          operationKey: liveKey,
          jobId,
          catalogStateId: Number(row.catalog_id),
          action: "zero_stock",
          target: "qty:0",
          owner: "reconcile",
          mutate: async () => {
            const r = await applyConfirmedNoValidSource({
              workspaceId: row.workspace_id,
              userId: row.user_id as string,
              catalogStateId: Number(row.catalog_id),
              asin: scan.asin,
              confirmationSource: "SERVER_BROWSER_PUBLIC",
              logicalOperationId: `${liveKey}:reconcile`,
              decision,
            })
            return {
              ok: r.planAction !== "zero_stock_failed",
              ebayMutated: r.ebayMutated === true,
              error: r.planAction,
            }
          },
          readback: async () => {
            const q = await readOxylabsApplyQuantity(row.workspace_id, Number(row.catalog_id))
            return { matchesTarget: q === 0, observed: q == null ? null : String(q) }
          },
        })
        action = `retry:${gated.skipped ?? (gated.applied ? "APPLIED" : "none")}`
      }
    }
    const failEvents = events.rows.filter(e => e.ebay_item_id === row.ebay_item_id)
    report.push({
      ebayItemId: row.ebay_item_id,
      catalogId: row.catalog_id,
      jobId: matchedJob?.id ?? null,
      asin: eventAsin,
      dbQty,
      ebayReadbackQty: ebayQty,
      botReason: row.bot_zeroed_reason,
      operationKey,
      action,
      eventTypes: failEvents.map(e => e.event_type),
      duplicateAttempts: failEvents.length,
    })
  }
  console.log(JSON.stringify({ listings: report, jobs: jobs.rows }, null, 2))
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
