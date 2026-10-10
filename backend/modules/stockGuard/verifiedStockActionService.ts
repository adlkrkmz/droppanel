import { query } from "../../db/client"
import { loadAmazonVerificationConfig } from "../amazonVerification/amazonVerificationConfig"
import {
  classifyVerifiedAmazonSource,
  isConfirmedSourceFailure,
  isAutomaticZeroDecisionSafe,
  verificationNeedsUserApproval,
  type VerifiedSourceDecision,
} from "../amazonVerification/verifiedSourceDecision"
import { emitActivityEvent } from "../activity/activityEventService"
import { upsertPendingReviewItem } from "../stockAlerts/stockAlertsRepository"
import {
  ignoreUncertainReviewIfUnchanged,
  updateActiveReviewReason,
} from "../stockAlerts/stockAlertReviewLifecycle"
import {
  formatVerifiedCheckPendingReason,
  type PriceConfirmationSource,
} from "../stockAlerts/stockAlertUserMessages"
import { getStockGuardSettings } from "./stockGuardSettingsRepository"
import { planVerifiedStockAction } from "./verifiedStockActionPlan"
import { resolveApplySourceAsin } from "../monitor/listingAsinResolve"
import { resolveTrustedBaselinePrice } from "../globalKeepa/keepaRadarCandidate"
import {
  activityLogicalKey,
  classifySourceApplyGuard,
  isListingLiveForV2,
  isV2KeepaMonitorEligible,
} from "../globalKeepa/sourceAsinLifecycle"
import {
  applyAcceptedSourcePrice,
  persistVerifiedCatalogState,
} from "./acceptedSourcePricePipeline"
import { applyConfirmedNoValidSource } from "./confirmedNoValidSourcePipeline"

export type ApplyVerifiedResult = {
  decision: VerifiedSourceDecision
  planAction: string
  ebayMutated: boolean
  alreadyCompleted?: boolean
}

export { persistVerifiedCatalogState }

export async function applyVerifiedSourceResult(input: {
  workspaceId: string
  userId: string
  taskId: number
  alreadyCompleted?: boolean
  confirmationSource?: PriceConfirmationSource
  payload: {
    requestedAsin: string
    finalAsin?: unknown
    displayedPrice?: number | null
    condition?: string | null
    isPrime?: boolean | null
    isFba?: boolean | null
    shipsFromAmazon?: boolean | null
    purchasable?: "TRUE" | "FALSE" | "UNKNOWN" | null
    stockStatus?: string | null
    availabilityText?: string | null
    pageUnavailable?: boolean | null
    redirected?: boolean | null
    captcha?: boolean | null
    loginRequired?: boolean | null
    offerPageHealthy?: boolean | null
  }
}): Promise<ApplyVerifiedResult> {
  // Extension default provenance: confirmationSource: "EXTENSION_VERIFIED"
  const confirmationSource: PriceConfirmationSource = input.confirmationSource ?? "EXTENSION_VERIFIED"
  const decision = classifyVerifiedAmazonSource({
    requestedAsin: input.payload.requestedAsin,
    finalAsin: input.payload.finalAsin,
    displayedPrice: input.payload.displayedPrice,
    condition: input.payload.condition,
    isPrime: input.payload.isPrime,
    isFba: input.payload.isFba,
    shipsFromAmazon: input.payload.shipsFromAmazon,
    purchasable: input.payload.purchasable,
    stockStatus: input.payload.stockStatus,
    availabilityText: input.payload.availabilityText,
    pageUnavailable: input.payload.pageUnavailable,
    redirected: input.payload.redirected,
    captcha: input.payload.captcha,
    loginRequired: input.payload.loginRequired,
    offerPageHealthy: input.payload.offerPageHealthy,
  })

  // Desktop observations are diagnostic only while server automation is enabled.
  // Keep this before the idempotent path so an old Desktop result cannot be replayed.
  if (confirmationSource === "DESKTOP_AGENT") {
    return { decision, planAction: "desktop_agent_disabled", ebayMutated: false }
  }

  if (input.alreadyCompleted) {
    return { decision, planAction: "idempotent", ebayMutated: false, alreadyCompleted: true }
  }

  const cfg = loadAmazonVerificationConfig()
  const task = await query<{
    catalog_state_id: string
    asin: string
    workspace_id: string
    status: string
    completed_at: string | null
  }>(
    `SELECT catalog_state_id::text, asin, workspace_id::text, status, completed_at
     FROM amazon_price_verification_tasks WHERE id = $1::bigint`,
    [input.taskId]
  )
  const row = task.rows[0]
  if (!row) return { decision, planAction: "task_missing", ebayMutated: false }
  if (row.status !== "COMPLETED" || !row.completed_at) {
    return { decision, planAction: "task_not_completed", ebayMutated: false }
  }
  const latestTask = await query<{ id: string }>(
    `SELECT id::text FROM amazon_price_verification_tasks
     WHERE workspace_id = $1::uuid AND catalog_state_id = $2::bigint
     ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [input.workspaceId, Number(row.catalog_state_id)]
  )
  if (latestTask.rows[0] && Number(latestTask.rows[0].id) !== input.taskId) {
    return { decision, planAction: "stale_task", ebayMutated: false }
  }
  const catalogStateId = Number(row.catalog_state_id)

  const listing = await query<{
    store_id: string
    store_code: string
    store_name: string
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
    bot_zeroed_at: string | null
    registry_asin: string | null
    source_url: string | null
  }>(
    `SELECT scs.store_id::text, st.store_code, st.name AS store_name,
            scs.ebay_quantity::text, scs.ebay_price::text, scs.source_price::text,
            scs.last_verified_source_price::text, scs.last_verified_decision,
            scs.last_verified_asin, scs.internal_sku, scs.ebay_item_id, scs.ebay_offer_id,
            scs.ebay_title, scs.image_url, scs.current_status::text AS current_status,
            scs.stock_guard_enabled, scs.bot_zeroed_at::text AS bot_zeroed_at,
            ar.asin AS registry_asin, scs.source_url
     FROM store_catalog_state scs
     JOIN stores st ON st.id = scs.store_id AND st.workspace_id = scs.workspace_id
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid AND scs.id = $2::bigint
     LIMIT 1`,
    [input.workspaceId, catalogStateId]
  )
  const cat = listing.rows[0]
  if (!cat) return { decision, planAction: "listing_missing", ebayMutated: false }

  const consumerRes = await query<{ consumer_asin: string | null }>(
    `SELECT g.asin AS consumer_asin
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     WHERE c.catalog_state_id = $1::bigint
     LIMIT 1`,
    [catalogStateId]
  )
  const currentAsin = resolveApplySourceAsin({
    registryAsin: cat.registry_asin,
    sourceUrl: cat.source_url,
    internalSku: cat.internal_sku?.trim() ?? "",
    consumerAsin: consumerRes.rows[0]?.consumer_asin ?? null,
  })
  const settingsRow = await getStockGuardSettings(input.workspaceId, Number(cat.store_id))
  const settings = {
    enabled: true,
    mode: "auto" as "manual" | "auto",
    priceAlertEnabled: true,
    autoProfitProtectionEnabled: true,
  }
  const listingGuardOn = cat.stock_guard_enabled !== false
  const monitorEligible = isV2KeepaMonitorEligible({
    currentStatus: cat.current_status,
    stockGuardEnabled: listingGuardOn,
    ebayItemId: cat.ebay_item_id,
    ebayQuantity: cat.ebay_quantity != null ? Number(cat.ebay_quantity) : 0,
    sourceAsin: currentAsin,
  })
  const applyGuard = classifySourceApplyGuard({
    taskAsin: row.asin,
    currentSourceAsin: currentAsin,
    consumerAsin: consumerRes.rows[0]?.consumer_asin ?? null,
    listingLive: isListingLiveForV2(cat.current_status),
    stockGuardEnabled: listingGuardOn,
    monitorEligible,
    ebayQuantity: cat.ebay_quantity != null ? Number(cat.ebay_quantity) : 0,
  })
  if (!applyGuard.ok) {
    if (
      decision.code === "PRODUCT_NOT_FOUND" ||
      decision.code === "ASIN_REMOVED" ||
      decision.code === "PRODUCT_UNAVAILABLE"
    ) {
      await persistVerifiedCatalogState({
        workspaceId: input.workspaceId,
        catalogStateId,
        decision,
        applySourcePrice: false,
      }).catch(() => undefined)
    }
    if (decision.outcome === "UNKNOWN" && verificationNeedsUserApproval(decision.code)) {
      const reason = formatVerifiedCheckPendingReason(decision.code)
      await updateActiveReviewReason({
        workspaceId: input.workspaceId,
        catalogStateId,
        reason,
        sourceStatus: "PRICE_UNCERTAIN",
      }).catch(() => undefined)
    } else {
      await ignoreUncertainReviewIfUnchanged({
        workspaceId: input.workspaceId,
        catalogStateId,
      }).catch(() => undefined)
    }
    return { decision, planAction: applyGuard.code, ebayMutated: false }
  }

  if (decision.outcome === "VALID_SOURCE") {
    return applyAcceptedSourcePrice({
      workspaceId: input.workspaceId,
      userId: input.userId,
      catalogStateId,
      asin: row.asin,
      confirmationSource,
      logicalOperationId: `task:${input.taskId}`,
      decision,
    })
  }

  if (isConfirmedSourceFailure(decision.outcome) && !isAutomaticZeroDecisionSafe(decision)) {
    return { decision, planAction: "unsafe_confirmed_result", ebayMutated: false }
  }

  if (isConfirmedSourceFailure(decision.outcome)) {
    return applyConfirmedNoValidSource({
      workspaceId: input.workspaceId,
      userId: input.userId,
      catalogStateId,
      asin: row.asin,
      confirmationSource,
      logicalOperationId: `task:${input.taskId}`,
      decision,
    })
  }

  await persistVerifiedCatalogState({
    workspaceId: input.workspaceId,
    catalogStateId,
    decision,
    applySourcePrice: cfg.applySourcePrice,
  }).catch(e => console.warn("[verified-source] catalog persist skipped:", e instanceof Error ? e.message : e))

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

  const asin = row.asin
  const storeId = Number(cat.store_id)
  const eventKey = (kind: string) => activityLogicalKey(kind, input.taskId)

  if (plan.action === "source_restored" || plan.action === "verified_ok" || plan.action === "none") {
    await ignoreUncertainReviewIfUnchanged({
      workspaceId: input.workspaceId,
      catalogStateId,
    }).catch(() => undefined)
    return { decision, planAction: plan.action, ebayMutated: false }
  }

  if (plan.action === "approval_required") {
    const reason = formatVerifiedCheckPendingReason(decision.code)
    const promoted = await updateActiveReviewReason({
      workspaceId: input.workspaceId,
      catalogStateId,
      reason,
      sourceStatus: "PRICE_UNCERTAIN",
    }).catch(() => false)
    if (!promoted) {
      await upsertPendingReviewItem({
        workspaceId: input.workspaceId,
        storeId,
        catalogStateId,
        ebayItemId: cat.ebay_item_id,
        internalSku: cat.internal_sku,
        asin,
        ebayTitle: cat.ebay_title,
        imageUrl: cat.image_url,
        ebayQuantity: qty,
        ebayPrice: cat.ebay_price != null ? Number(cat.ebay_price) : null,
        sourceStatus: "PRICE_UNCERTAIN",
        sourceStatusReason: reason,
        sourcePrice: decision.acceptedPrice,
      }).catch(() => undefined)
    }
    await emitActivityEvent({
      workspaceId: input.workspaceId,
      storeId,
      eventType: "PRICE_APPROVAL_REQUIRED",
      severity: "warning",
      title: "Doğrulama onay bekliyor",
      message: reason,
      catalogStateId,
      asin,
      ebayItemId: cat.ebay_item_id,
      idempotencyKey: eventKey("source_invalid_gated"),
    })
    return { decision, planAction: "approval_required", ebayMutated: false }
  }

  return { decision, planAction: "none", ebayMutated: false }
}
