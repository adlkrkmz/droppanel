import { query } from "../../db/client"
import { insertAuditLog } from "../auth/authRepository"
import { loadAmazonVerificationConfig } from "../amazonVerification/amazonVerificationConfig"
import type { VerifiedSourceDecision } from "../amazonVerification/verifiedSourceDecision"
import {
  emitActivityEvent,
  findActivityByIdempotencyKey,
} from "../activity/activityEventService"
import {
  formatPriceIncreaseMessage,
  formatProfitProtectionMessage,
} from "../activity/activityMessages"
import { calculateRecommendedEbayPrice } from "../pricing/pricingCalculatorService"
import { loadPromotionPricingContext } from "../pricing/promotionPricingContext"
import { persistCatalogEbayPrice, updateListingPriceOnEbay } from "../listings/listingsEbayPriceService"
import { upsertPendingReviewItem } from "../stockAlerts/stockAlertsRepository"
import { evaluateKeepaDirectMutationGate } from "../keepaSensor/keepaDirectMutationGate"
import {
  ignoreUncertainReviewIfUnchanged,
  markActiveReviewActioned,
  markActiveReviewIgnored,
  markActiveReviewFailed,
  updateActiveReviewReason,
} from "../stockAlerts/stockAlertReviewLifecycle"
import {
  formatPriceIncreasePendingReason,
  formatProfitProtectionFailedReason,
  formatProfitProtectionReason,
  PROFIT_PROTECTION_NOOP_IGNORE,
  safeEbayErrorMessage,
  type PriceConfirmationSource,
} from "../stockAlerts/stockAlertUserMessages"
import { planVerifiedStockAction } from "./verifiedStockActionPlan"
import { resolveApplySourceAsin } from "../monitor/listingAsinResolve"
import { resolveTrustedBaselinePrice } from "../globalKeepa/keepaRadarCandidate"
import {
  activityLogicalKey,
  classifySourceApplyGuard,
  isListingLiveForV2,
  isV2KeepaMonitorEligible,
  profitProtectionIdempotencyKey,
} from "../globalKeepa/sourceAsinLifecycle"

const simulationMode = () => (process.env.EBAY_SIMULATION ?? "true") !== "false"

export type ApplyAcceptedSourceResult = {
  decision: VerifiedSourceDecision
  planAction: string
  ebayMutated: boolean
  alreadyCompleted?: boolean
}

type ListingRow = {
  store_id: string
  store_code: string
  store_status: string | null
  ebay_quantity: string | null
  ebay_price: string | null
  source_price: string | null
  last_verified_source_price: string | null
  last_verified_decision: string | null
  last_verified_asin: string | null
  internal_sku: string | null
  ebay_item_id: string | null
  ebay_offer_id: string | null
  ebay_title: string | null
  image_url: string | null
  current_status: string | null
  stock_guard_enabled: boolean | null
  registry_asin: string | null
  source_url: string | null
}

export async function persistVerifiedCatalogState(input: {
  workspaceId: string
  catalogStateId: number
  decision: VerifiedSourceDecision
  applySourcePrice: boolean
  sourceStatusReason?: string | null
}): Promise<void> {
  const outcome = input.decision.outcome
  const listingStatus =
    outcome === "VALID_SOURCE"
      ? "AMAZON_OK"
      : outcome === "CONFIRMED_NO_VALID_SOURCE" || outcome === "SOURCE_ASIN_REDIRECTED"
        ? "UNAVAILABLE"
        : null
  const listingReason =
    listingStatus === "AMAZON_OK"
      ? input.sourceStatusReason?.trim() || "Amazon OK"
      : listingStatus === "UNAVAILABLE"
        ? input.sourceStatusReason?.trim() || "Amazon'da geçerli Prime/FBA kaynak bulunamadı."
        : null
  await query(
    `UPDATE store_catalog_state
     SET last_verified_source_price = CASE
           WHEN $4 = 'VALID_SOURCE' AND $3::numeric IS NOT NULL THEN $3::numeric
           ELSE last_verified_source_price
         END,
         last_verified_at = CASE
           WHEN $4 IN ('VALID_SOURCE', 'CONFIRMED_NO_VALID_SOURCE', 'SOURCE_ASIN_REDIRECTED') THEN NOW()
           ELSE last_verified_at
         END,
         last_verified_decision = CASE
           WHEN $4 IN ('VALID_SOURCE', 'CONFIRMED_NO_VALID_SOURCE', 'SOURCE_ASIN_REDIRECTED') THEN $4
           ELSE last_verified_decision
         END,
         last_verified_asin = CASE
           WHEN $4 IN ('VALID_SOURCE', 'CONFIRMED_NO_VALID_SOURCE', 'SOURCE_ASIN_REDIRECTED')
             AND NULLIF(BTRIM(COALESCE($5::text, '')), '') IS NOT NULL THEN $5
           ELSE last_verified_asin
         END,
         source_price = CASE
           WHEN $6::boolean AND $4 = 'VALID_SOURCE' AND $3::numeric IS NOT NULL
                AND source_price IS DISTINCT FROM $3::numeric
           THEN $3::numeric
           ELSE source_price
         END,
         source_price_changed_at = CASE
           WHEN $6::boolean AND $4 = 'VALID_SOURCE' AND $3::numeric IS NOT NULL
                AND source_price IS DISTINCT FROM $3::numeric
           THEN NOW()
           ELSE source_price_changed_at
         END,
         source_status = CASE
           WHEN $7::text IS NOT NULL AND source_status IS DISTINCT FROM $7::text THEN $7::text
           ELSE source_status
         END,
         source_status_reason = CASE
           WHEN $7::text IS NOT NULL AND source_status IS DISTINCT FROM $7::text THEN $8::text
           ELSE source_status_reason
         END,
         source_checked_at = CASE
           WHEN $7::text IS NOT NULL THEN NOW()
           ELSE source_checked_at
         END,
         updated_at = NOW()
     WHERE workspace_id = $1::uuid AND id = $2::bigint`,
    [
      input.workspaceId,
      input.catalogStateId,
      input.decision.acceptedPrice,
      input.decision.outcome,
      input.decision.outcome === "VALID_SOURCE"
        ? input.decision.finalAsin ?? input.decision.requestedAsin
        : input.decision.requestedAsin || input.decision.finalAsin,
      input.applySourcePrice && input.decision.outcome === "VALID_SOURCE",
      listingStatus,
      listingReason,
    ]
  )
}

/**
 * Common accepted-source-price → increase → profit-protection pipeline.
 * Keepa CONFIRMED and Extension VALID_SOURCE share this financial path.
 */
export async function applyAcceptedSourcePrice(input: {
  workspaceId: string
  userId: string
  catalogStateId: number
  asin: string
  confirmationSource: PriceConfirmationSource
  logicalOperationId: string
  decision: VerifiedSourceDecision
  permitEbayMutation?: boolean
}): Promise<ApplyAcceptedSourceResult> {
  const decision = input.decision
  const keepaGate = evaluateKeepaDirectMutationGate(input.confirmationSource)
  if (!keepaGate.allowed) {
    return { decision, planAction: keepaGate.skip!, ebayMutated: false }
  }
  const listing = await query<ListingRow>(
    `SELECT scs.store_id::text, st.store_code, st.status AS store_status,
            scs.ebay_quantity::text, scs.ebay_price::text, scs.source_price::text,
            scs.last_verified_source_price::text, scs.last_verified_decision,
            scs.last_verified_asin, scs.internal_sku, scs.ebay_item_id, scs.ebay_offer_id,
            scs.ebay_title, scs.image_url, scs.current_status::text AS current_status,
            scs.stock_guard_enabled,
            ar.asin AS registry_asin, scs.source_url
     FROM store_catalog_state scs
     JOIN stores st ON st.id = scs.store_id AND st.workspace_id = scs.workspace_id
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid AND scs.id = $2::bigint
     LIMIT 1`,
    [input.workspaceId, input.catalogStateId]
  )
  const cat = listing.rows[0]
  if (!cat) return { decision, planAction: "listing_missing", ebayMutated: false }

  const consumerRes = await query<{ consumer_asin: string | null }>(
    `SELECT g.asin AS consumer_asin
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     WHERE c.catalog_state_id = $1::bigint
     LIMIT 1`,
    [input.catalogStateId]
  )
  const currentAsin = resolveApplySourceAsin({
    registryAsin: cat.registry_asin,
    sourceUrl: cat.source_url,
    internalSku: cat.internal_sku?.trim() ?? "",
    consumerAsin: consumerRes.rows[0]?.consumer_asin ?? null,
  })
  const settings = {
    enabled: true,
    mode: "auto" as "manual" | "auto",
    priceAlertEnabled: true,
    autoProfitProtectionEnabled: true,
  }
  const listingGuardOn = cat.stock_guard_enabled !== false
  const storeActive = String(cat.store_status ?? "").trim().toLowerCase() === "active"
  const monitorEligible = isV2KeepaMonitorEligible({
    currentStatus: cat.current_status,
    stockGuardEnabled: listingGuardOn,
    ebayItemId: cat.ebay_item_id,
    ebayQuantity: cat.ebay_quantity != null ? Number(cat.ebay_quantity) : 0,
    sourceAsin: currentAsin,
    storeActive,
  })
  const applyGuard = classifySourceApplyGuard({
    taskAsin: input.asin,
    currentSourceAsin: currentAsin,
    consumerAsin: consumerRes.rows[0]?.consumer_asin ?? null,
    listingLive: isListingLiveForV2(cat.current_status),
    stockGuardEnabled: listingGuardOn,
    monitorEligible,
    ebayQuantity: cat.ebay_quantity != null ? Number(cat.ebay_quantity) : 0,
  })
  if (!applyGuard.ok) {
    await ignoreUncertainReviewIfUnchanged({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
    }).catch(() => undefined)
    return { decision, planAction: applyGuard.code, ebayMutated: false }
  }

  const cfg = loadAmazonVerificationConfig()
  const qty = cat.ebay_quantity != null ? Number(cat.ebay_quantity) : null
  const trusted = resolveTrustedBaselinePrice({
    lastVerifiedPrice:
      cat.last_verified_source_price != null ? Number(cat.last_verified_source_price) : null,
    sourcePrice: cat.source_price != null ? Number(cat.source_price) : null,
    lastVerifiedAsin: cat.last_verified_asin,
    currentSourceAsin: currentAsin,
    lastVerifiedDecision: cat.last_verified_decision,
  })
  const plan = planVerifiedStockAction({
    decision,
    settings,
    currentEbayQuantity: Number.isFinite(qty as number) ? qty : null,
    trustedBaselinePrice: trusted != null && Number.isFinite(trusted) ? trusted : null,
    lastVerifiedDecision: cat.last_verified_decision,
    lastVerifiedAsin: cat.last_verified_asin,
    currentSourceAsin: currentAsin,
    verifiedActionsEnabled: true,
  })

  const asin = input.asin
  const storeId = Number(cat.store_id)
  const persistAccepted = async () => {
    await persistVerifiedCatalogState({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
      decision,
      applySourcePrice: true,
    })
  }

  if (plan.action === "source_restored" || plan.action === "verified_ok" || plan.action === "none") {
    if (plan.action === "verified_ok" || plan.action === "source_restored") {
      await persistAccepted().catch(e =>
        console.warn("[accepted-source] catalog persist skipped:", e instanceof Error ? e.message : e)
      )
    }
    await ignoreUncertainReviewIfUnchanged({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
    }).catch(() => undefined)
    return { decision, planAction: plan.action, ebayMutated: false }
  }

  if (plan.action === "notify_increase_only") {
    await persistAccepted().catch(e =>
      console.warn("[accepted-source] catalog persist skipped:", e instanceof Error ? e.message : e)
    )
    const amazonBefore = plan.amazonBefore
    const amazonAfter = plan.amazonAfter
    const operationKey = profitProtectionIdempotencyKey(
      input.catalogStateId,
      Math.round(amazonAfter * 100)
    )
    if (settings.priceAlertEnabled) {
      const reason = formatPriceIncreasePendingReason(amazonBefore, amazonAfter)
      let promoted = false
      try {
        promoted = await updateActiveReviewReason({
          workspaceId: input.workspaceId,
          catalogStateId: input.catalogStateId,
          reason,
          sourceStatus: "PRICE_INCREASE",
          sourcePrice: amazonAfter,
          oldSourcePrice: amazonBefore,
          newSourcePrice: amazonAfter,
          verificationSource: input.confirmationSource,
          operationType: "PRICE_PROTECTION",
          operationKey,
        })
      } catch {
        promoted = false
      }
      if (!promoted) {
        await upsertPendingReviewItem({
          workspaceId: input.workspaceId,
          storeId,
          catalogStateId: input.catalogStateId,
          ebayItemId: cat.ebay_item_id,
          internalSku: cat.internal_sku,
          asin,
          ebayTitle: cat.ebay_title,
          imageUrl: cat.image_url,
          ebayQuantity: qty,
          ebayPrice: cat.ebay_price != null ? Number(cat.ebay_price) : null,
          sourceStatus: "PRICE_INCREASE",
          sourceStatusReason: reason,
          sourcePrice: amazonAfter,
          oldSourcePrice: amazonBefore,
          newSourcePrice: amazonAfter,
          verificationSource: input.confirmationSource,
          operationType: "PRICE_PROTECTION",
          operationKey,
        }).catch(() => undefined)
      }
      const msg = formatPriceIncreaseMessage({ asin, before: amazonBefore, after: amazonAfter })
      await emitActivityEvent({
        workspaceId: input.workspaceId,
        storeId,
        userId: input.userId,
        eventType: "PRICE_APPROVAL_REQUIRED",
        severity: "warning",
        title: msg.title,
        message: reason,
        catalogStateId: input.catalogStateId,
        asin,
        ebayItemId: cat.ebay_item_id,
        beforeData: { amazon: amazonBefore },
        afterData: { amazon: amazonAfter, source: input.confirmationSource },
        idempotencyKey: activityLogicalKey("price_approval", input.logicalOperationId),
      })
      await ignoreUncertainReviewIfUnchanged({
        workspaceId: input.workspaceId,
        catalogStateId: input.catalogStateId,
      }).catch(() => undefined)
    }
    return { decision, planAction: "price_approval_required", ebayMutated: false }
  }

  if (plan.action !== "profit_protection") {
    return { decision, planAction: plan.action, ebayMutated: false }
  }

  if (input.permitEbayMutation === false) {
    await persistAccepted().catch(() => undefined)
    return { decision, planAction: "profit_protection_blocked_unconfirmed", ebayMutated: false }
  }

  const amazonAfter = plan.amazonAfter
  const amazonBefore = plan.amazonBefore
  const currentEbay = cat.ebay_price != null ? Number(cat.ebay_price) : null
  if (currentEbay == null || currentEbay <= 0) {
    await persistAccepted().catch(() => undefined)
    await ignoreUncertainReviewIfUnchanged({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
    }).catch(() => undefined)
    return { decision, planAction: "profit_protection_skipped", ebayMutated: false }
  }
  const promotion = await loadPromotionPricingContext({
    workspaceId: input.workspaceId,
    storeId,
    catalogStateId: input.catalogStateId,
  })
  const calc = await calculateRecommendedEbayPrice({
    workspaceId: input.workspaceId,
    storeId,
    amazonPrice: amazonAfter,
    promotion,
  })
  if (calc.recommendedEbayPrice <= currentEbay) {
    await persistAccepted().catch(() => undefined)
    await markActiveReviewIgnored({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
      reason: PROFIT_PROTECTION_NOOP_IGNORE,
      sourceStatus: "PRICE_INCREASE",
      sourcePrice: amazonAfter,
      oldSourcePrice: amazonBefore,
      newSourcePrice: amazonAfter,
      ebayPrice: currentEbay,
    }).catch(() => undefined)
    await ignoreUncertainReviewIfUnchanged({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
    }).catch(() => undefined)
    return { decision, planAction: "profit_protection_no_raise", ebayMutated: false }
  }
  if (simulationMode()) {
    return { decision, planAction: "profit_protection_simulation", ebayMutated: false }
  }

  const ppKey = profitProtectionIdempotencyKey(
    input.catalogStateId,
    Math.round(amazonAfter * 100),
    calc.promotionApplied
      ? {
          adRatePercent: calc.promotionAdRatePercent,
          targetEbayCents: Math.round(calc.recommendedEbayPrice * 100),
        }
      : undefined
  )
  const existing = await findActivityByIdempotencyKey(input.workspaceId, ppKey)
  if (existing) {
    const priorEbay = Number(existing.afterData?.ebay)
    const priorMatchesCurrent =
      Number.isFinite(priorEbay) &&
      priorEbay > 0 &&
      Math.round(priorEbay * 100) === Math.round(currentEbay * 100)
    if (priorMatchesCurrent) {
      await persistAccepted().catch(() => undefined)
      await markActiveReviewIgnored({
        workspaceId: input.workspaceId,
        catalogStateId: input.catalogStateId,
        reason: PROFIT_PROTECTION_NOOP_IGNORE,
        sourceStatus: "PRICE_INCREASE",
        sourcePrice: amazonAfter,
        oldSourcePrice: amazonBefore,
        newSourcePrice: amazonAfter,
        ebayPrice: currentEbay,
      }).catch(() => undefined)
      return {
        decision,
        planAction: "profit_protection_noop",
        ebayMutated: false,
        alreadyCompleted: true,
      }
    }
    if (Number.isFinite(priorEbay) && priorEbay > 0) {
      await persistCatalogEbayPrice({
        workspaceId: input.workspaceId,
        storeId,
        catalogStateId: input.catalogStateId,
        newPrice: priorEbay,
        manual: false,
        oldPrice: currentEbay,
        autoReason: "Verified profit protection",
      }).catch(() => undefined)
    }
    await persistAccepted().catch(() => undefined)
    await markActiveReviewActioned({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
      reason: formatProfitProtectionReason({
        amazonBefore,
        amazonAfter,
        ebayBefore: currentEbay,
        ebayAfter: Number.isFinite(priorEbay) && priorEbay > 0 ? priorEbay : calc.recommendedEbayPrice,
        confirmation: input.confirmationSource,
      }),
      sourceStatus: "PRICE_INCREASE",
      sourcePrice: amazonAfter,
      oldSourcePrice: amazonBefore,
      newSourcePrice: amazonAfter,
      verificationSource: input.confirmationSource,
      operationType: "PRICE_PROTECTION",
      operationKey: ppKey,
    }).catch(() => undefined)
    return {
      decision,
      planAction: "profit_protection",
      ebayMutated: false,
      alreadyCompleted: true,
    }
  }

  let ebayMutationWarnings: unknown[] = []
  let appliedEbayPrice = calc.recommendedEbayPrice
  let didMutateEbay = false
  const pricesEqualSafe = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100)
  try {
    const mutation = await updateListingPriceOnEbay(input.workspaceId, cat.store_code, {
      internalSku: cat.internal_sku,
      ebayItemId: cat.ebay_item_id,
      ebayOfferId: cat.ebay_offer_id,
      newPrice: calc.recommendedEbayPrice,
      catalogStateId: input.catalogStateId,
      storeId,
      listingLive: isListingLiveForV2(cat.current_status),
    })
    ebayMutationWarnings = mutation.warnings ?? []
    if (!pricesEqualSafe(mutation.readbackPrice, calc.recommendedEbayPrice)) {
      throw new Error("eBay inventory readback did not match target price")
    }
    appliedEbayPrice = mutation.readbackPrice
    didMutateEbay = mutation.mutated === true
  } catch (e) {
    const err = safeEbayErrorMessage(e instanceof Error ? e.message : String(e))
    const reason = formatProfitProtectionFailedReason({
      amazonBefore,
      amazonAfter,
      currentEbay,
      targetEbay: calc.recommendedEbayPrice,
      error: err,
    })
    // A verified Amazon price is independent of a later eBay mutation.  Keep
    // the listing's source column current so the seller sees the evidence that
    // caused the alert and a manual retry uses the right recommendation.
    await persistAccepted().catch(persistError =>
      console.error("[AcceptedSourcePrice] failed to persist verified source after eBay mutation failure:", persistError)
    )
    await markActiveReviewFailed({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
      reason,
      actionError: err,
      sourceStatus: "PRICE_INCREASE",
      sourcePrice: amazonAfter,
      oldSourcePrice: amazonBefore,
      newSourcePrice: amazonAfter,
      verificationSource: input.confirmationSource,
      operationType: "PRICE_PROTECTION",
      operationKey: ppKey,
    }).catch(() => undefined)
    // The Amazon evidence is still valid even when the eBay mutation fails.
    // Keep a visible pending retry instead of letting a routine Desktop check
    // erase the unresolved protection work.
    await emitActivityEvent({
      workspaceId: input.workspaceId,
      storeId,
      userId: input.userId,
      eventType: "ACTION_FAILED",
      severity: "error",
      title: "PRICE PROTECTION FAILED",
      message: reason,
      catalogStateId: input.catalogStateId,
      asin,
      ebayItemId: cat.ebay_item_id,
      beforeData: { amazon: amazonBefore, ebay: currentEbay },
      afterData: { amazon: amazonAfter, targetEbay: calc.recommendedEbayPrice, source: input.confirmationSource },
      idempotencyKey: activityLogicalKey("action_failed", input.logicalOperationId),
    })
    return { decision, planAction: "profit_protection_failed", ebayMutated: false }
  }

  await persistCatalogEbayPrice({
    workspaceId: input.workspaceId,
    storeId,
    catalogStateId: input.catalogStateId,
    newPrice: appliedEbayPrice,
    manual: false,
    oldPrice: currentEbay,
    autoReason: "Verified profit protection",
  })
  await persistAccepted()
  const reason = formatProfitProtectionReason({
    amazonBefore,
    amazonAfter,
    ebayBefore: currentEbay,
    ebayAfter: appliedEbayPrice,
    confirmation: input.confirmationSource,
  })
  await markActiveReviewActioned({
    workspaceId: input.workspaceId,
    catalogStateId: input.catalogStateId,
    reason,
    sourceStatus: "PRICE_INCREASE",
    sourcePrice: amazonAfter,
    oldSourcePrice: amazonBefore,
    newSourcePrice: amazonAfter,
    ebayPrice: appliedEbayPrice,
    verificationSource: input.confirmationSource,
    operationType: "PRICE_PROTECTION",
    operationKey: ppKey,
  }).catch(() => undefined)
  const msg = formatProfitProtectionMessage({
    asin,
    amazonBefore,
    amazonAfter,
    ebayBefore: currentEbay,
    ebayAfter: appliedEbayPrice,
    confirmation: input.confirmationSource,
  })
  await emitActivityEvent({
    workspaceId: input.workspaceId,
    storeId,
    userId: input.userId,
    eventType: "PRICE_PROTECTION_APPLIED",
    severity: "success",
    title: msg.title,
    message: reason,
    catalogStateId: input.catalogStateId,
    asin,
    ebayItemId: cat.ebay_item_id,
    beforeData: {
      amazon: amazonBefore,
      ebay: currentEbay,
      source: input.confirmationSource,
    },
    afterData: {
      amazon: amazonAfter,
      ebay: appliedEbayPrice,
      source: input.confirmationSource,
      logicalOperationId: input.logicalOperationId,
      ebayWarnings: ebayMutationWarnings,
    },
    idempotencyKey: ppKey,
  })
  await insertAuditLog({
    actorUserId: input.userId,
    action: "stock_guard.verified_profit_protection",
    targetType: "store_catalog_state",
    targetId: String(input.catalogStateId),
    metadata: {
      asin,
      amazonBefore,
      amazonAfter,
      ebayBefore: currentEbay,
      ebayAfter: appliedEbayPrice,
      source: input.confirmationSource,
      logicalOperationId: input.logicalOperationId,
    },
  }).catch(() => undefined)
  return { decision, planAction: "profit_protection", ebayMutated: didMutateEbay }
}
