import { query } from "../../db/client"
import { loadAmazonVerificationConfig } from "../amazonVerification/amazonVerificationConfig"
import { calculateRecommendedEbayPrice } from "../pricing/pricingCalculatorService"
import { loadPromotionPricingContext } from "../pricing/promotionPricingContext"
import { applyAcceptedSourcePrice } from "../stockGuard/acceptedSourcePricePipeline"
import { applyConfirmedNoValidSource } from "../stockGuard/confirmedNoValidSourcePipeline"
import { planVerifiedStockAction } from "../stockGuard/verifiedStockActionPlan"
import { resolveApplySourceAsin } from "../monitor/listingAsinResolve"
import { classifySourceApplyGuard, isListingLiveForV2, isV2KeepaMonitorEligible } from "../globalKeepa/sourceAsinLifecycle"
import { GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE } from "../globalKeepa/globalKeepaEligibility"
import { resolveTrustedBaselinePrice } from "../globalKeepa/keepaRadarCandidate"
import { getScanJob } from "../amazonScan/amazonScanJobQueue"
import { markKeepaVerifyCandidateStatus } from "../keepaSensor/keepaVerifyChain"
import { loadOxylabsVerifyConfig } from "./oxylabsVerifyConfig"
import { OXYLABS_PRODUCT_PRIMARY } from "./oxylabsVerifyKinds"
import { normalizeOxylabsAmazonProduct, oxylabsProductFingerprint } from "./oxylabsProductNormalize"
import {
  decideOxylabsSingleQuery,
  mapOxylabsToVerifiedDecision,
  oxylabsOperationKey,
  type OxylabsPanelListing,
} from "./oxylabsProductDecision"
import { persistOxylabsPolicyOnJob } from "./oxylabsProductReclassify"
import {
  OXYLABS_APPLY_PROVIDER,
  newOxylabsApplyOwner,
  oxylabsMutationOperationKey,
  runOxylabsGuardedMutation,
  resetZeroStockKillSwitchOnValidSource,
  type OxylabsApplyAction,
} from "./oxylabsApplyOperations"
import { readOxylabsApplyPrice, readOxylabsApplyQuantity } from "./oxylabsApplyEbayReadback"
import type { ApplyConfirmedNoValidSourceResult } from "../stockGuard/confirmedNoValidSourcePipeline"
import type { ApplyAcceptedSourceResult } from "../stockGuard/acceptedSourcePricePipeline"

export type OxylabsCompletedApplyResult = {
  applied: number
  confirmQueued: boolean
  skipped: string
  alreadyClaimed: number
  alreadyApplied: number
  recovered: number
}

export type OxylabsCompletedApplyDeps = {
  owner?: string
  now?: Date
  leaseMs?: number
  applyZero?: (input: Parameters<typeof applyConfirmedNoValidSource>[0]) => Promise<ApplyConfirmedNoValidSourceResult>
  applyPrice?: (input: Parameters<typeof applyAcceptedSourcePrice>[0]) => Promise<ApplyAcceptedSourceResult>
  readQty?: (workspaceId: string, catalogStateId: number) => Promise<number | null>
  readPrice?: (workspaceId: string, catalogStateId: number) => Promise<number | null>
}

export async function applyOxylabsCompletedScanJob(
  jobId: number,
  deps: OxylabsCompletedApplyDeps = {}
): Promise<OxylabsCompletedApplyResult> {
  const empty = {
    applied: 0,
    confirmQueued: false,
    skipped: "",
    alreadyClaimed: 0,
    alreadyApplied: 0,
    recovered: 0,
  }
  const oxy = loadOxylabsVerifyConfig()
  const job = await getScanJob(jobId)
  if (!job || job.kind !== OXYLABS_PRODUCT_PRIMARY) {
    return { ...empty, skipped: "JOB_MISSING" }
  }
  const full = await query<{
    status: string
    result_payload: Record<string, unknown> | null
    observed_at: Date | null
  }>(
    `SELECT status, result_payload, observed_at
     FROM amazon_scan_jobs WHERE id = $1::bigint`,
    [jobId]
  )
  const row = full.rows[0]
  if (!row || row.status !== "COMPLETED" || !row.result_payload) {
    return { ...empty, skipped: "NOT_COMPLETED" }
  }
  const n = normalizeOxylabsAmazonProduct({
    requestedAsin: job.asin,
    payload: row.result_payload,
    geoLocation: oxy.geoLocation,
  })
  const consumers = await query<{
    workspace_id: string
    catalog_state_id: string
    store_id: string
    user_id: string | null
    ebay_quantity: string | null
    source_price: string | null
    last_verified_source_price: string | null
    last_verified_asin: string | null
    last_verified_decision: string | null
    registry_asin: string | null
    source_url: string | null
    internal_sku: string | null
    current_status: string | null
    stock_guard_enabled: boolean | null
    ebay_item_id: string | null
  }>(
    `SELECT c.workspace_id::text AS workspace_id,
            c.catalog_state_id::text AS catalog_state_id,
            scs.store_id::text AS store_id,
            scs.ebay_quantity::text,
            scs.source_price::text,
            scs.last_verified_source_price::text,
            scs.last_verified_asin,
            scs.last_verified_decision,
            ar.asin AS registry_asin,
            scs.source_url,
            scs.internal_sku,
            scs.current_status::text,
            scs.stock_guard_enabled,
            scs.ebay_item_id,
            (
              SELECT wm.user_id::text FROM workspace_members wm
              WHERE wm.workspace_id = c.workspace_id
              ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, wm.created_at ASC
              LIMIT 1
            ) AS user_id
     FROM global_asin_consumers c
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     LEFT JOIN asin_registry ar ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE c.global_asin_id = $1::bigint
       AND ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE}`,
    [job.globalAsinId]
  )

  const panelListing: OxylabsPanelListing | null = (() => {
    const cat = consumers.rows[0]
    if (!cat) return null
    const currentAsin = resolveApplySourceAsin({
      registryAsin: cat.registry_asin,
      sourceUrl: cat.source_url,
      internalSku: cat.internal_sku?.trim() ?? "",
      consumerAsin: job.asin,
    })
    return {
      sourceAsin: currentAsin,
      sourcePrice: cat.source_price != null ? Number(cat.source_price) : null,
      listingLive: isListingLiveForV2(cat.current_status),
      qty: cat.ebay_quantity != null ? Number(cat.ebay_quantity) : 0,
    }
  })()
  const classified = decideOxylabsSingleQuery({
    n,
    panel: panelListing,
    mutationsEnabled: oxy.mutationsEnabled,
  })
  await persistOxylabsPolicyOnJob(jobId, {
    version: 4,
    productClass: classified.productClass,
    code: classified.code,
    evidenceCode: classified.evidenceCode,
    enqueueConfirm: false,
    followReason: classified.audit,
    evaluatedAt: new Date().toISOString(),
    primeEvidence: n.primeEvidence,
    primeEligible: n.isPrimeEligible,
    primeEvidenceStrength: n.primeEvidenceStrength,
    mutationsEnabled: oxy.mutationsEnabled,
  })
  if (classified.productClass === "PRODUCT_INCONCLUSIVE") {
    await markKeepaVerifyCandidateStatus(job.keepaCandidateId, "INCONCLUSIVE")
    return { ...empty, skipped: "PRODUCT_INCONCLUSIVE" }
  }
  if (classified.productClass === "VALID_SOURCE") await resetZeroStockKillSwitchOnValidSource()
  if (classified.audit === "NO_BUSINESS_CHANGE") {
    await markKeepaVerifyCandidateStatus(job.keepaCandidateId, "NO_BUSINESS_CHANGE")
    return { ...empty, skipped: "NO_BUSINESS_CHANGE" }
  }

  const vcfg = loadAmazonVerificationConfig()
  const decision = mapOxylabsToVerifiedDecision({ n, productClass: classified.productClass, code: classified.evidenceCode })
  let mutationCandidate = false
  const plans: Array<{
    catalogStateId: number
    workspaceId: string
    storeId: number
    userId: string
    action: string
    trusted: number | null
  }> = []

  for (const cat of consumers.rows) {
    if (!cat.user_id) continue
    if (job.deliveryZip && job.deliveryZip !== oxy.geoLocation) continue
    const currentAsin = resolveApplySourceAsin({
      registryAsin: cat.registry_asin,
      sourceUrl: cat.source_url,
      internalSku: cat.internal_sku?.trim() ?? "",
      consumerAsin: job.asin,
    })
    if (currentAsin && currentAsin !== job.asin) continue
    const listingGuardOn = cat.stock_guard_enabled !== false
    const monitorEligible = isV2KeepaMonitorEligible({
      currentStatus: cat.current_status,
      stockGuardEnabled: listingGuardOn,
      ebayItemId: cat.ebay_item_id,
      ebayQuantity: cat.ebay_quantity != null ? Number(cat.ebay_quantity) : 0,
      sourceAsin: currentAsin ?? job.asin,
    })
    const applyGuard = classifySourceApplyGuard({
      taskAsin: job.asin,
      currentSourceAsin: currentAsin,
      consumerAsin: job.asin,
      listingLive: isListingLiveForV2(cat.current_status),
      stockGuardEnabled: listingGuardOn,
      monitorEligible,
      ebayQuantity: cat.ebay_quantity != null ? Number(cat.ebay_quantity) : 0,
    })
    if (!applyGuard.ok) continue
    const trusted = resolveTrustedBaselinePrice({
      lastVerifiedPrice: cat.last_verified_source_price != null ? Number(cat.last_verified_source_price) : null,
      sourcePrice: cat.source_price != null ? Number(cat.source_price) : null,
      lastVerifiedAsin: cat.last_verified_asin,
      currentSourceAsin: currentAsin ?? job.asin,
      lastVerifiedDecision: cat.last_verified_decision,
    })
    const plan = planVerifiedStockAction({
      decision,
      settings: {
        enabled: true,
        mode: "auto",
        priceAlertEnabled: true,
        autoProfitProtectionEnabled: true,
      },
      currentEbayQuantity: cat.ebay_quantity != null ? Number(cat.ebay_quantity) : null,
      trustedBaselinePrice: trusted,
      lastVerifiedDecision: cat.last_verified_decision,
      verifiedActionsEnabled: vcfg.verifiedStockActionsEnabled,
      lastVerifiedAsin: cat.last_verified_asin,
      currentSourceAsin: currentAsin ?? job.asin,
    })
    if (plan.action === "zero_stock" || plan.action === "profit_protection" || plan.action === "verified_ok") {
      mutationCandidate = true
    }
    if (plan.action === "notify_increase_only" || plan.action === "verified_ok") {
      /* price decrease or no raise → no ebay mutation */
    }
    plans.push({
      catalogStateId: Number(cat.catalog_state_id),
      workspaceId: cat.workspace_id,
      storeId: Number(cat.store_id),
      userId: cat.user_id,
      action: plan.action,
      trusted,
    })
  }

  const fp = oxylabsProductFingerprint(n, classified.productClass)

  if (!classified.applyMutation || !mutationCandidate) {
    await markKeepaVerifyCandidateStatus(job.keepaCandidateId, "MATCHED")
    return { ...empty, skipped: classified.audit }
  }

  if (!oxy.mutationsEnabled) {
    await markKeepaVerifyCandidateStatus(job.keepaCandidateId, "MATCHED")
    return { ...empty, skipped: classified.audit }
  }

  const applyZero = deps.applyZero ?? applyConfirmedNoValidSource
  const applyPrice = deps.applyPrice ?? applyAcceptedSourcePrice
  const readQty = deps.readQty ?? readOxylabsApplyQuantity
  const readPrice = deps.readPrice ?? readOxylabsApplyPrice
  const owner = deps.owner ?? newOxylabsApplyOwner("handler")

  let applied = 0
  let alreadyClaimed = 0
  let alreadyApplied = 0
  let recovered = 0
  for (const p of plans) {
    if (p.action !== "zero_stock" && p.action !== "profit_protection" && p.action !== "verified_ok") continue
    const logical = oxylabsOperationKey({
      provider: "OXYLABS_PRODUCT",
      candidateId: job.keepaCandidateId,
      fingerprint: fp,
    }) + `:${p.catalogStateId}`
    if (decision.outcome === "VALID_SOURCE" && p.action === "verified_ok") {
      await applyPrice({
        workspaceId: p.workspaceId,
        userId: p.userId,
        catalogStateId: p.catalogStateId,
        asin: job.asin,
        confirmationSource: "SERVER_BROWSER_PUBLIC",
        logicalOperationId: logical,
        decision,
        permitEbayMutation: true,
      })
      applied++
      continue
    }
    const gatedAction: OxylabsApplyAction | null =
      p.action === "zero_stock"
        ? "zero_stock"
        : p.action === "profit_protection"
          ? "profit_protection"
          : null
    if (!gatedAction) continue
    const target =
      gatedAction === "zero_stock"
        ? "qty:0"
        : `amazon_cents:${Math.round(Number(decision.acceptedPrice ?? 0) * 100)}`
    const operationKey = oxylabsMutationOperationKey({
      provider: OXYLABS_APPLY_PROVIDER,
      jobId,
      candidateId: job.keepaCandidateId,
      fingerprint: fp,
      action: gatedAction,
      target,
      catalogStateId: p.catalogStateId,
    })
    const gated = await runOxylabsGuardedMutation({
      operationKey,
      jobId,
      catalogStateId: p.catalogStateId,
      action: gatedAction,
      target,
      owner,
      now: deps.now,
      leaseMs: deps.leaseMs,
      mutate: async () => {
        if (gatedAction === "zero_stock") {
          const r = await applyZero({
            workspaceId: p.workspaceId,
            userId: p.userId,
            catalogStateId: p.catalogStateId,
            asin: job.asin,
            confirmationSource: "SERVER_BROWSER_PUBLIC",
            logicalOperationId: logical,
            decision,
          })
          return {
            ok: r.planAction !== "zero_stock_failed",
            ebayMutated: r.ebayMutated === true,
            error: r.planAction,
          }
        }
        const r = await applyPrice({
          workspaceId: p.workspaceId,
          userId: p.userId,
          catalogStateId: p.catalogStateId,
          asin: job.asin,
          confirmationSource: "SERVER_BROWSER_PUBLIC",
          logicalOperationId: logical,
          decision,
          permitEbayMutation: true,
        })
        return {
          ok: r.planAction !== "profit_protection_failed",
          ebayMutated: r.ebayMutated === true,
          error: r.planAction,
        }
      },
      readback: async () => {
        if (gatedAction === "zero_stock") {
          const q = await readQty(p.workspaceId, p.catalogStateId)
          return { matchesTarget: q === 0, observed: q == null ? null : String(q) }
        }
        const pr = await readPrice(p.workspaceId, p.catalogStateId)
        const amazon = Number(decision.acceptedPrice ?? 0)
        const promotion =
          Number.isFinite(p.storeId) && p.storeId > 0
            ? await loadPromotionPricingContext({
                workspaceId: p.workspaceId,
                storeId: p.storeId,
                catalogStateId: p.catalogStateId,
              })
            : undefined
        const calc = Number.isFinite(p.storeId) && p.storeId > 0 && amazon > 0
          ? await calculateRecommendedEbayPrice({
              workspaceId: p.workspaceId,
              storeId: p.storeId,
              amazonPrice: amazon,
              promotion,
            })
          : { recommendedEbayPrice: 0 }
        const targetCents = Math.round(calc.recommendedEbayPrice * 100)
        return {
          matchesTarget: pr != null && targetCents > 0 && Math.round(pr * 100) === targetCents,
          observed: pr == null ? null : String(pr),
        }
      },
    })
    if (gated.skipped === "already_claimed") alreadyClaimed++
    if (gated.skipped === "already_applied") alreadyApplied++
    if (gated.recovered) recovered++
    if (gated.applied) applied++
  }
  await markKeepaVerifyCandidateStatus(job.keepaCandidateId, "MATCHED")
  return {
    applied,
    confirmQueued: false,
    skipped: applied > 0 ? "OK" : alreadyClaimed > 0 ? "already_claimed" : alreadyApplied > 0 ? "already_applied" : "NO_ELIGIBLE_LISTING",
    alreadyClaimed,
    alreadyApplied,
    recovered,
  }
}
