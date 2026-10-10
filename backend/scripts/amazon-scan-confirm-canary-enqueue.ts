import "dotenv/config"
import { classifyVerifiedAmazonSource } from "../modules/amazonVerification/verifiedSourceDecision"
import { planVerifiedStockAction } from "../modules/stockGuard/verifiedStockActionPlan"
import { GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE } from "../modules/globalKeepa/globalKeepaEligibility"
import { enqueueScanJob } from "../modules/amazonScan/amazonScanJobQueue"
import { loadAmazonScanConfig } from "../modules/amazonScan/amazonScanConfig"
import { query } from "../db/client"

function decisionFromPayload(asin: string, payload: Record<string, unknown>) {
  return classifyVerifiedAmazonSource({
    requestedAsin: asin,
    finalAsin: payload.finalAsin,
    displayedPrice: typeof payload.displayedPrice === "number" ? payload.displayedPrice : null,
    condition: typeof payload.condition === "string" ? payload.condition : null,
    isPrime: typeof payload.isPrime === "boolean" ? payload.isPrime : null,
    isFba: typeof payload.isFba === "boolean" ? payload.isFba : null,
    shipsFromAmazon: typeof payload.shipsFromAmazon === "boolean" ? payload.shipsFromAmazon : null,
    purchasable:
      payload.purchasable === "TRUE" || payload.purchasable === "FALSE" || payload.purchasable === "UNKNOWN"
        ? payload.purchasable
        : null,
    stockStatus: typeof payload.stockStatus === "string" ? payload.stockStatus : null,
    availabilityText: typeof payload.availabilityText === "string" ? payload.availabilityText : null,
    pageUnavailable: payload.pageUnavailable === true,
    redirected: payload.redirected === true,
    captcha: payload.captcha === true,
    timeout: payload.timeout === true,
    uncertain: payload.uncertain === true,
    offerPageHealthy: payload.offerPageHealthy === true,
  })
}

async function main(): Promise<void> {
  const cfg = loadAmazonScanConfig()
  if (cfg.plannerEnabled || cfg.applyProcessorEnabled || cfg.remoteWorkersEnabled) {
    throw new Error("unsafe flags")
  }
  const rows = await query<{ job_id: string; global_asin_id: string; asin: string; payload: Record<string, unknown> }>(
    `SELECT o.job_id::text, j.global_asin_id::text, j.asin, o.payload
     FROM amazon_scan_apply_outbox o
     JOIN amazon_scan_jobs j ON j.id = o.job_id
     WHERE o.status = 'PENDING' AND j.session_class LIKE 'CANARY%'
     ORDER BY o.id`
  )
  const picked: Array<{ oldJobId: number; globalAsinId: number; asin: string }> = []
  const seen = new Set<number>()
  for (const r of rows.rows) {
    const d = decisionFromPayload(r.asin, r.payload ?? {})
    if (d.outcome !== "VALID_SOURCE") continue
    const cons = await query<{ q: string | null; lastp: string | null; lastd: string | null }>(
      `SELECT scs.ebay_quantity::text AS q, scs.last_verified_source_price::text AS lastp, scs.last_verified_decision AS lastd
       FROM global_asin_consumers c
       JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
       JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
       WHERE c.global_asin_id = $1::bigint AND ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE}
       LIMIT 1`,
      [Number(r.global_asin_id)]
    )
    if (!cons.rows[0]) continue
    const plan = planVerifiedStockAction({
      decision: d,
      settings: { enabled: true, mode: "auto", priceAlertEnabled: true, autoProfitProtectionEnabled: true },
      currentEbayQuantity: cons.rows[0].q != null ? Number(cons.rows[0].q) : null,
      trustedBaselinePrice: cons.rows[0].lastp != null ? Number(cons.rows[0].lastp) : null,
      lastVerifiedDecision: cons.rows[0].lastd,
      verifiedActionsEnabled: true,
    })
    if (plan.action !== "profit_protection") continue
    const gid = Number(r.global_asin_id)
    if (seen.has(gid)) continue
    seen.add(gid)
    picked.push({ oldJobId: Number(r.job_id), globalAsinId: gid, asin: r.asin })
    if (picked.length >= 2) break
  }
  if (!picked.length) {
    console.log(JSON.stringify({ phase: "no_candidates", candidateCount: 0 }))
    return
  }
  const created: number[] = []
  for (const p of picked) {
    const made = await enqueueScanJob({
      globalAsinId: p.globalAsinId,
      asin: p.asin,
      marketplace: cfg.marketplace,
      deliveryZip: cfg.deliveryZip,
      sessionClass: cfg.sessionClass,
      kind: "ROUTINE",
      priority: 0,
      requireFreshNav: false,
    })
    if (!made.created || !made.jobId) throw new Error("enqueue failed")
    created.push(made.jobId)
  }
  console.log(
    JSON.stringify({
      phase: "enqueued",
      sessionClass: cfg.sessionClass,
      candidateCount: picked.length,
      sourceOldJobIds: picked.map(p => p.oldJobId),
      routineJobIds: created,
    })
  )
}

void main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
