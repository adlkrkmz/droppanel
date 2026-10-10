import type { VerifiedSourceDecision, VerifiedSourceOutcome } from "../amazonVerification/verifiedSourceDecision"
import { isConfirmedSourceFailure, verificationNeedsUserApproval } from "../amazonVerification/verifiedSourceDecision"

export type StockGuardV2Settings = {
  enabled: boolean
  mode: "manual" | "auto"
  priceAlertEnabled: boolean
  autoProfitProtectionEnabled: boolean
}

export type VerifiedActionPlan =
  | { action: "none"; reason: string }
  | { action: "approval_required"; code: string }
  | { action: "zero_stock"; safetyRule: "CONFIRMED_NO_VALID_SOURCE"; evenInManual: true }
  | { action: "price_approval_required"; amazonBefore: number; amazonAfter: number }
  | { action: "profit_protection"; amazonBefore: number; amazonAfter: number }
  | { action: "notify_increase_only"; amazonBefore: number; amazonAfter: number }
  | { action: "source_restored"; amazonAfter: number | null }
  | { action: "verified_ok"; amazonAfter: number | null }

/**
 * Shared planner for accepted source prices (Keepa CONFIRMED and Extension VALID_SOURCE).
 * Independent qty0 reasons even in manual: gone page, out of stock, Prime missing, FBA missing,
 * confirmed ASIN mismatch. Captcha / login stay no mutation.
 * Profit protection is automatic when enabled; disabled protection remains manual approval.
 * Auto profit protection only raises eBay price. Amazon unchanged still checks required vs current eBay.
 * Decreases never auto-reprice.
 */
export function planVerifiedStockAction(input: {
  decision: VerifiedSourceDecision
  settings: StockGuardV2Settings
  currentEbayQuantity: number | null
  trustedBaselinePrice: number | null
  lastVerifiedDecision: string | null
  verifiedActionsEnabled: boolean
  lastVerifiedAsin?: string | null
  currentSourceAsin?: string | null
}): VerifiedActionPlan {
  if (input.decision.outcome === "UNKNOWN") {
    if (verificationNeedsUserApproval(input.decision.code)) {
      return { action: "approval_required", code: input.decision.code }
    }
    return { action: "none", reason: "UNKNOWN_NO_MUTATION" }
  }

  if (isConfirmedSourceFailure(input.decision.outcome)) {
    if ((input.currentEbayQuantity ?? 0) <= 0) {
      return { action: "none", reason: "ALREADY_ZERO" }
    }
    return { action: "zero_stock", safetyRule: "CONFIRMED_NO_VALID_SOURCE", evenInManual: true }
  }

  if (input.decision.outcome !== "VALID_SOURCE") {
    return { action: "none", reason: "NO_VALID_PLAN" }
  }

  const lastAsin = String(input.lastVerifiedAsin ?? "").trim().toUpperCase()
  const currentAsin = String(input.currentSourceAsin ?? "").trim().toUpperCase()
  const newSourceBaseline = Boolean(currentAsin) && Boolean(lastAsin) && lastAsin !== currentAsin

  if (newSourceBaseline && input.decision.code !== "KEEPA_CONFIRMED") {
    return { action: "verified_ok", amazonAfter: input.decision.acceptedPrice }
  }

  const restored =
    !newSourceBaseline &&
    (input.lastVerifiedDecision === "CONFIRMED_NO_VALID_SOURCE" ||
      input.lastVerifiedDecision === "SOURCE_ASIN_REDIRECTED")
  if (restored) {
    return { action: "verified_ok", amazonAfter: input.decision.acceptedPrice }
  }

  const after = input.decision.acceptedPrice
  const before = newSourceBaseline ? null : input.trustedBaselinePrice
  if (after == null) {
    return { action: "verified_ok", amazonAfter: null }
  }
  const amazonDecreased = before != null && after < before - 0.01
  if (amazonDecreased || (before != null && Math.abs(after - before) <= 0.01 && input.decision.code !== "KEEPA_CONFIRMED")) {
    return { action: "verified_ok", amazonAfter: after }
  }

  if (!input.settings.autoProfitProtectionEnabled && before != null && after > before + 0.01) {
    return { action: "price_approval_required", amazonBefore: before, amazonAfter: after }
  }

  const amazonBefore = before ?? after
  return { action: "profit_protection", amazonBefore, amazonAfter: after }
}

export function verifiedOutcomeIsFailure(outcome: VerifiedSourceOutcome): boolean {
  return isConfirmedSourceFailure(outcome)
}
