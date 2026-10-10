import { query } from "../../db/client"
import { insertAuditLog } from "../auth/authRepository"
import type { VerifiedSourceDecision } from "../amazonVerification/verifiedSourceDecision"
import { isAutomaticZeroDecisionSafe } from "../amazonVerification/verifiedSourceDecision"
import { emitActivityEvent } from "../activity/activityEventService"
import { formatStockZeroMessage } from "../activity/activityMessages"
import {
  markActiveReviewActioned,
  markActiveReviewFailed,
  ignoreUncertainReviewIfUnchanged,
} from "../stockAlerts/stockAlertReviewLifecycle"
import { zeroListingQuantityOnEbay } from "../stockAlerts/stockAlertsEbayZeroService"
import {
  formatStockZeroFailedReason,
  formatStockZeroReason,
  safeEbayErrorMessage,
  type PriceConfirmationSource,
} from "../stockAlerts/stockAlertUserMessages"
import { persistVerifiedCatalogState } from "./acceptedSourcePricePipeline"
import { evaluateKeepaDirectMutationGate } from "../keepaSensor/keepaDirectMutationGate"
import { planVerifiedStockAction } from "./verifiedStockActionPlan"
import { resolveApplySourceAsin } from "../monitor/listingAsinResolve"
import {
  classifySourceApplyGuard,
  isListingLiveForV2,
  isV2KeepaMonitorEligible,
  stockZeroIdempotencyKey,
} from "../globalKeepa/sourceAsinLifecycle"
import { afterListingStockGuardZeroed } from "./stockGuardV2LifecycleHooks"
import { isEligibleForAutomaticMutation } from "./automaticListingEligibility"

const simulationMode = () => (process.env.EBAY_SIMULATION ?? "true") !== "false"
const sandbox = () => (process.env.EBAY_SANDBOX ?? "true") !== "false"

export type ApplyConfirmedNoValidSourceResult = {
  decision: VerifiedSourceDecision
  planAction: string
  ebayMutated: boolean
  alreadyCompleted?: boolean
}

/**
 * Common confirmed no-valid-source → eBay qty0 pipeline.
 * Keepa FBM-only / no FBA and Extension confirmed failures share this path:
 * gone page, out of stock, Prime missing, or FBA missing.
 */
export async function applyConfirmedNoValidSource(input: {
  workspaceId: string
  userId: string
  catalogStateId: number
  asin: string
  confirmationSource: PriceConfirmationSource
  logicalOperationId: string
  decision: VerifiedSourceDecision
}): Promise<ApplyConfirmedNoValidSourceResult> {
  const decision = input.decision
  const keepaGate = evaluateKeepaDirectMutationGate(input.confirmationSource)
  if (!keepaGate.allowed) {
    return { decision, planAction: keepaGate.skip!, ebayMutated: false }
  }
  const listing = await query<{
    store_id: string
    store_code: string
    store_status: string | null
    ebay_quantity: string | null
    ebay_price: string | null
    internal_sku: string | null
    ebay_item_id: string | null
    ebay_offer_id: string | null
    ebay_title: string | null
    image_url: string | null
    current_status: string | null
    stock_guard_enabled: boolean | null
    registry_asin: string | null
    source_url: string | null
  }>(
    `SELECT scs.store_id::text, st.store_code, st.status AS store_status,
            scs.ebay_quantity::text, scs.ebay_price::text,
            scs.internal_sku, scs.ebay_item_id, scs.ebay_offer_id,
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
  const qty = cat.ebay_quantity != null ? Number(cat.ebay_quantity) : null
  const monitorEligible = isV2KeepaMonitorEligible({
    currentStatus: cat.current_status,
    stockGuardEnabled: listingGuardOn,
    ebayItemId: cat.ebay_item_id,
    ebayQuantity: qty != null && Number.isFinite(qty) ? qty : 0,
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
    ebayQuantity: qty != null && Number.isFinite(qty) ? qty : 0,
  })
  if (!applyGuard.ok) {
    await ignoreUncertainReviewIfUnchanged({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
    }).catch(() => undefined)
    return { decision, planAction: applyGuard.code, ebayMutated: false }
  }

  const plan = planVerifiedStockAction({
    decision,
    settings,
    currentEbayQuantity: Number.isFinite(qty as number) ? qty : null,
    trustedBaselinePrice: null,
    lastVerifiedDecision: null,
    currentSourceAsin: currentAsin,
    verifiedActionsEnabled: true,
  })
  if (!isAutomaticZeroDecisionSafe(decision)) {
    await ignoreUncertainReviewIfUnchanged({ workspaceId: input.workspaceId, catalogStateId: input.catalogStateId }).catch(() => undefined)
    return { decision, planAction: "unsafe_confirmed_result", ebayMutated: false }
  }

  if (plan.action !== "zero_stock") {
    await ignoreUncertainReviewIfUnchanged({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
    }).catch(() => undefined)
    return { decision, planAction: plan.action, ebayMutated: false }
  }

  const asin = input.asin
  const storeId = Number(cat.store_id)

  if (simulationMode()) {
    return { decision, planAction: "zero_stock_simulation", ebayMutated: false }
  }

  const immediatelyEligible = await isEligibleForAutomaticMutation({
    workspaceId: input.workspaceId,
    storeId,
    catalogStateId: input.catalogStateId,
  })
  if (!immediatelyEligible) return { decision, planAction: "guard_recheck_blocked", ebayMutated: false }

  const oldQty = qty ?? 0
  try {
    await zeroListingQuantityOnEbay(
      input.workspaceId,
      cat.store_code,
      {
        internalSku: cat.internal_sku,
        ebayItemId: cat.ebay_item_id,
        ebayOfferId: cat.ebay_offer_id,
      },
      sandbox()
    )
  } catch (e) {
    const err = safeEbayErrorMessage(e instanceof Error ? e.message : String(e))
    const reason = formatStockZeroFailedReason({ oldQty, error: err })
    await markActiveReviewFailed({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
      reason,
      actionError: err,
      sourceStatus: "UNAVAILABLE",
      verificationSource: input.confirmationSource,
      operationType: "STOCK_PROTECTION",
      operationKey: `v2:stock_zero:${input.logicalOperationId}`,
    }).catch(() => undefined)
    await emitActivityEvent({
      workspaceId: input.workspaceId,
      storeId,
      userId: input.userId,
      eventType: "STOCK_ZERO_FAILED",
      severity: "error",
      title: "STOCK ZERO FAILED",
      message: reason,
      catalogStateId: input.catalogStateId,
      asin,
      ebayItemId: cat.ebay_item_id,
      beforeData: { ebayQuantity: oldQty, source: input.confirmationSource },
      afterData: { ebayQuantity: oldQty, source: input.confirmationSource },
      idempotencyKey: `v2:stock_zero_failed:${input.logicalOperationId}`,
    })
    await persistVerifiedCatalogState({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
      decision,
      applySourcePrice: false,
      sourceStatusReason: formatStockZeroFailedReason({ oldQty, error: err }),
    }).catch(() => undefined)
    return { decision, planAction: "zero_stock_failed", ebayMutated: false }
  }

  await query(
    `UPDATE store_catalog_state
     SET ebay_quantity = 0,
         bot_zeroed_at = NOW(),
         bot_zeroed_by = $4,
         bot_zeroed_reason = $3,
         updated_at = NOW()
     WHERE workspace_id = $1::uuid AND id = $2::bigint AND COALESCE(ebay_quantity, 0) > 0`,
    [
      input.workspaceId,
      input.catalogStateId,
      decision.code,
      input.confirmationSource === "KEEPA_CONFIRMED" ? "keepa_confirmed_no_valid_source" : "verified_source_safety",
    ]
  )
  await persistVerifiedCatalogState({
    workspaceId: input.workspaceId,
    catalogStateId: input.catalogStateId,
    decision,
    applySourcePrice: false,
    sourceStatusReason:
      decision.code === "PRODUCT_NOT_FOUND" ||
      decision.code === "ASIN_REMOVED" ||
      decision.code === "PRODUCT_UNAVAILABLE"
        ? formatStockZeroReason({
            code: decision.code,
            oldQty,
            confirmation: input.confirmationSource,
          })
        : undefined,
  }).catch(() => undefined)
  await insertAuditLog({
    actorUserId: input.userId,
    action: "stock_guard.verified_zero",
    targetType: "store_catalog_state",
    targetId: String(input.catalogStateId),
    metadata: {
      workspaceId: input.workspaceId,
      asin,
      reason: decision.code,
      beforeQty: oldQty,
      afterQty: 0,
      source: input.confirmationSource,
      logicalOperationId: input.logicalOperationId,
    },
  }).catch(() => undefined)
  const reason = formatStockZeroReason({
    code: decision.code,
    oldQty,
    confirmation: input.confirmationSource,
  })
  await markActiveReviewActioned({
    workspaceId: input.workspaceId,
    catalogStateId: input.catalogStateId,
    reason,
    ebayQuantity: 0,
    verificationSource: input.confirmationSource,
    operationType: "STOCK_PROTECTION",
    operationKey: `v2:stock_zero:${input.logicalOperationId}`,
  }).catch(() => undefined)
  const msg = formatStockZeroMessage({
    asin,
    oldQty,
    confirmation: input.confirmationSource,
  })
  await emitActivityEvent({
    workspaceId: input.workspaceId,
    storeId,
    userId: input.userId,
    eventType: "STOCK_ZEROED",
    severity: "warning",
    title: msg.title,
    message: reason,
    catalogStateId: input.catalogStateId,
    asin,
    ebayItemId: cat.ebay_item_id,
    beforeData: { ebayQuantity: oldQty, source: input.confirmationSource },
    afterData: { ebayQuantity: 0, source: input.confirmationSource },
    idempotencyKey: stockZeroIdempotencyKey(input.catalogStateId),
  })
  await afterListingStockGuardZeroed({ workspaceId: input.workspaceId, storeId, catalogStateId: input.catalogStateId })
  return { decision, planAction: "zero_stock", ebayMutated: true }
}
