import { query } from "../../db/client"
import { classifyVerifiedAmazonSource } from "../amazonVerification/verifiedSourceDecision"
import { planVerifiedStockAction } from "../stockGuard/verifiedStockActionPlan"
import { persistVerifiedCatalogState, applyAcceptedSourcePrice } from "../stockGuard/acceptedSourcePricePipeline"
import { applyConfirmedNoValidSource } from "../stockGuard/confirmedNoValidSourcePipeline"
import { resolveApplySourceAsin } from "../monitor/listingAsinResolve"
import { classifySourceApplyGuard, isListingLiveForV2, isV2KeepaMonitorEligible } from "../globalKeepa/sourceAsinLifecycle"
import { GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE } from "../globalKeepa/globalKeepaEligibility"
import { loadAmazonVerificationConfig } from "../amazonVerification/amazonVerificationConfig"
import { resolveTrustedBaselinePrice } from "../globalKeepa/keepaRadarCandidate"
import { loadAmazonScanConfig } from "./amazonScanConfig"
import { enqueueScanJob, getScanJob } from "./amazonScanJobQueue"
import { markScanCadenceFailure, markScanCadenceSuccess } from "./amazonScanPlanner"
import { scanContextsCompatible } from "./amazonScanKey"
import {
  amazonScanConfirmMaxAgeMs,
  browserObservationFingerprint,
  evaluateScanApplyMutationGate,
  isScanObservationIncomplete,
} from "./amazonScanApplyPolicy"
import { markKeepaVerifyCandidateStatus } from "../keepaSensor/keepaVerifyChain"
import { keepaVerifyConfirmPersistMode } from "../keepaSensor/keepaVerifyChainPolicy"
import {
  loadKeepaCandidatePurpose,
  recordBrowserConfirmedTrustedState,
} from "../keepaSensor/keepaTrustedBaseline"

function observationFingerprint(
  asin: string,
  payload: Record<string, unknown>,
  decision: { outcome: string; acceptedPrice: number | null }
): string {
  return browserObservationFingerprint({
    asin,
    acceptedPrice: decision.acceptedPrice,
    isPrime: typeof payload.isPrime === "boolean" ? payload.isPrime : null,
    isFba: typeof payload.isFba === "boolean" ? payload.isFba : null,
    shipsFromAmazon: typeof payload.shipsFromAmazon === "boolean" ? payload.shipsFromAmazon : null,
    purchasable: typeof payload.purchasable === "string" ? payload.purchasable : null,
    stockStatus: typeof payload.stockStatus === "string" ? payload.stockStatus : null,
    outcome: decision.outcome,
  })
}

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

export async function applyCompletedScanJob(jobId: number): Promise<{ applied: number; confirmQueued: boolean; skipped: string }> {
  const job = await getScanJob(jobId)
  if (!job) return { applied: 0, confirmQueued: false, skipped: "JOB_MISSING" }
  if (job.kind === "OXYLABS_PRODUCT_PRIMARY" || job.kind === "OXYLABS_PRODUCT_CONFIRM") {
    const { applyOxylabsCompletedScanJob } = await import("../oxylabsVerify/oxylabsVerifyApply")
    return applyOxylabsCompletedScanJob(jobId)
  }
  const full = await query<{
    status: string
    result_payload: Record<string, unknown> | null
    observed_at: Date | null
    parent_job_id: string | null
  }>(
    `SELECT status, result_payload, observed_at, parent_job_id::text
     FROM amazon_scan_jobs WHERE id = $1::bigint`,
    [jobId]
  )
  const row = full.rows[0]
  if (!row || row.status !== "COMPLETED" || !row.result_payload) {
    return { applied: 0, confirmQueued: false, skipped: "NOT_COMPLETED" }
  }
  const payload = row.result_payload
  const keepaVerify = job.kind === "KEEPA_VERIFY_PRIMARY" || job.kind === "KEEPA_VERIFY_CONFIRM"
  if (isScanObservationIncomplete(payload)) {
    if (!keepaVerify) await markScanCadenceFailure(job.globalAsinId)
    else await markKeepaVerifyCandidateStatus(job.keepaCandidateId, "RETRYABLE")
    return { applied: 0, confirmQueued: false, skipped: "INCOMPLETE_NO_MUTATION" }
  }
  const decision = decisionFromPayload(job.asin, payload)
  if (decision.outcome === "UNKNOWN") {
    if (!keepaVerify) await markScanCadenceFailure(job.globalAsinId)
    else await markKeepaVerifyCandidateStatus(job.keepaCandidateId, "RETRYABLE")
    return { applied: 0, confirmQueued: false, skipped: "UNKNOWN_NO_MUTATION" }
  }

  const confirmKind = job.kind === "CONFIRM" || job.kind === "KEEPA_VERIFY_CONFIRM"
  const parentRow =
    confirmKind && job.parentJobId
      ? await query<{ result_payload: Record<string, unknown> | null; observed_at: Date | null }>(
          `SELECT result_payload, observed_at FROM amazon_scan_jobs WHERE id = $1::bigint AND status = 'COMPLETED'`,
          [job.parentJobId]
        )
      : { rows: [] as Array<{ result_payload: Record<string, unknown> | null; observed_at: Date | null }> }
  const parentPayload = parentRow.rows[0]?.result_payload ?? null
  const parentObservedAt = parentRow.rows[0]?.observed_at ? new Date(parentRow.rows[0].observed_at).getTime() : null
  const parentDecision = parentPayload ? decisionFromPayload(job.asin, parentPayload) : null
  const fingerprintMatch = Boolean(
    parentDecision && observationFingerprint(job.asin, parentPayload ?? {}, parentDecision) === observationFingerprint(job.asin, payload, decision)
  )

  if (job.kind === "KEEPA_VERIFY_PRIMARY") {
    return { applied: 0, confirmQueued: false, skipped: "KEEPA_VERIFY_PRIMARY_NO_MUTATION" }
  }

  const consumers = await query<{
    workspace_id: string
    catalog_state_id: string
    user_id: string | null
    store_id: string
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
            scs.store_id::text,
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

  const vcfg = loadAmazonVerificationConfig()
  let mutationCandidate = false
  const plans: Array<{ catalogStateId: number; workspaceId: string; userId: string; action: string }> = []

  for (const cat of consumers.rows) {
    if (!cat.user_id) continue
    const currentAsin = resolveApplySourceAsin({
      registryAsin: cat.registry_asin,
      sourceUrl: cat.source_url,
      internalSku: cat.internal_sku?.trim() ?? "",
      consumerAsin: job.asin,
    })
    if (currentAsin && currentAsin !== job.asin) continue
    if (
      !scanContextsCompatible(
        {
          asin: job.asin,
          marketplace: job.marketplace,
          deliveryZip: job.deliveryZip,
          sessionClass: job.sessionClass,
        },
        {
          asin: job.asin,
          marketplace: loadAmazonScanConfig().marketplace,
          deliveryZip: loadAmazonScanConfig().deliveryZip,
          sessionClass: loadAmazonScanConfig().sessionClass,
        }
      )
    ) {
      continue
    }
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
    if (plan.action === "zero_stock" || plan.action === "profit_protection") mutationCandidate = true
    plans.push({
      catalogStateId: Number(cat.catalog_state_id),
      workspaceId: cat.workspace_id,
      userId: cat.user_id,
      action: plan.action,
    })
  }

  const gate = evaluateScanApplyMutationGate({
    kind: job.kind === "CONFIRM" || job.kind === "KEEPA_VERIFY_CONFIRM" ? job.kind : "ROUTINE",
    incomplete: false,
    decisionOutcome: decision.outcome,
    fingerprintMatch,
    hasParent: Boolean(confirmKind && job.parentJobId && parentPayload),
    parentObservedAtMs: parentObservedAt,
    resultObservedAtMs: row.observed_at ? new Date(row.observed_at).getTime() : null,
    nowMs: Date.now(),
    maxAgeMs: amazonScanConfirmMaxAgeMs(),
    mutationCandidate,
  })

  if (job.kind === "ROUTINE" && gate.skip === "CONFIRM_QUEUED") {
    await enqueueScanJob({
      globalAsinId: job.globalAsinId,
      asin: job.asin,
      marketplace: job.marketplace,
      deliveryZip: job.deliveryZip,
      sessionClass: job.sessionClass,
      kind: "CONFIRM",
      priority: 0,
      parentJobId: job.id,
      requireFreshNav: true,
    })
    await markScanCadenceSuccess(job.globalAsinId, row.observed_at ? new Date(row.observed_at) : new Date())
    return { applied: 0, confirmQueued: true, skipped: "CONFIRM_QUEUED" }
  }

  const purpose = job.kind === "KEEPA_VERIFY_CONFIRM" ? await loadKeepaCandidatePurpose(job.keepaCandidateId) : null
  const persistMode =
    job.kind === "KEEPA_VERIFY_CONFIRM"
      ? keepaVerifyConfirmPersistMode({
          purpose,
          gateSkip: gate.skip,
          allowEbayMutation: gate.allowEbayMutation,
          persistObservationOnly: gate.persistObservationOnly,
        })
      : null

  if (gate.skip) {
    if (job.kind === "KEEPA_VERIFY_CONFIRM") {
      if (gate.skip === "CONFIRM_CONFLICT") {
        await markKeepaVerifyCandidateStatus(job.keepaCandidateId, "CONFLICT")
      } else {
        await markKeepaVerifyCandidateStatus(job.keepaCandidateId, "RETRYABLE")
      }
      return { applied: 0, confirmQueued: false, skipped: gate.skip }
    }
    await markScanCadenceFailure(job.globalAsinId)
    return { applied: 0, confirmQueued: false, skipped: gate.skip }
  }

  if (persistMode === "trusted_baseline") {
    for (const p of plans) {
      await recordBrowserConfirmedTrustedState({
        workspaceId: p.workspaceId,
        catalogStateId: p.catalogStateId,
        userId: p.userId,
        globalAsinId: job.globalAsinId,
        asin: job.asin,
        workerId: job.workerId,
        payload,
        decision,
        purpose,
        applySourcePrice: false,
      })
    }
    await markKeepaVerifyCandidateStatus(job.keepaCandidateId, "MATCHED")
    return { applied: 0, confirmQueued: false, skipped: "TRUSTED_BASELINE_NO_MUTATION" }
  }

  let applied = 0
  for (const p of plans) {
    const logical = `scan:${jobId}:${p.catalogStateId}`
    if (gate.persistObservationOnly) {
      if (job.kind === "KEEPA_VERIFY_CONFIRM") {
        await recordBrowserConfirmedTrustedState({
          workspaceId: p.workspaceId,
          catalogStateId: p.catalogStateId,
          userId: p.userId,
          globalAsinId: job.globalAsinId,
          asin: job.asin,
          workerId: job.workerId,
          payload,
          decision,
          purpose,
          applySourcePrice: false,
        })
      } else {
        await persistVerifiedCatalogState({
          workspaceId: p.workspaceId,
          catalogStateId: p.catalogStateId,
          decision,
          applySourcePrice: false,
        })
      }
      applied++
      continue
    }
    if (!gate.allowEbayMutation) continue
    if (!loadAmazonScanConfig().applyEnabled) continue
    if (decision.outcome === "VALID_SOURCE") {
      await applyAcceptedSourcePrice({
        workspaceId: p.workspaceId,
        userId: p.userId,
        catalogStateId: p.catalogStateId,
        asin: job.asin,
        confirmationSource: "SERVER_BROWSER_PUBLIC",
        logicalOperationId: logical,
        decision,
        permitEbayMutation: true,
      })
      if (job.kind === "KEEPA_VERIFY_CONFIRM") {
        await recordBrowserConfirmedTrustedState({
          workspaceId: p.workspaceId,
          catalogStateId: p.catalogStateId,
          userId: p.userId,
          globalAsinId: job.globalAsinId,
          asin: job.asin,
          workerId: job.workerId,
          payload,
          decision,
          purpose,
          applySourcePrice: false,
          skipCatalogPersist: true,
        })
      }
      applied++
    } else if (decision.outcome === "CONFIRMED_NO_VALID_SOURCE" || decision.outcome === "SOURCE_ASIN_REDIRECTED") {
      await applyConfirmedNoValidSource({
        workspaceId: p.workspaceId,
        userId: p.userId,
        catalogStateId: p.catalogStateId,
        asin: job.asin,
        confirmationSource: "SERVER_BROWSER_PUBLIC",
        logicalOperationId: logical,
        decision,
      })
      applied++
    }
  }
  if (job.kind === "KEEPA_VERIFY_CONFIRM") {
    await markKeepaVerifyCandidateStatus(job.keepaCandidateId, "MATCHED")
  } else {
    await markScanCadenceSuccess(job.globalAsinId, row.observed_at ? new Date(row.observed_at) : new Date())
  }
  return { applied, confirmQueued: false, skipped: applied > 0 ? "OK" : "NO_ELIGIBLE_LISTING" }
}
