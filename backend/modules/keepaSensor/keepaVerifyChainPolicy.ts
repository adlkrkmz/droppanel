export const KEEPA_VERIFY_PRIMARY_ACTIVE_CAP = 50
export const KEEPA_TRUSTED_BASELINE_PURPOSE = "TRUSTED_BASELINE"
export const KEEPA_VERIFY_PURPOSE = "VERIFY"

export const KEEPA_VERIFY_PRIMARY_CODES = [
  "KEEPA_SNAPSHOT_CHANGED",
  "BASELINE_PRICE_MISMATCH",
  "CONFIRMED_PRICE_MISMATCH",
  "PRICE_EVIDENCE_MISMATCH",
  "STOCK_RISK",
  "PRIME_RISK",
  "ASIN_IDENTITY_MISMATCH",
  "KEEPA_IDENTITY_SUSPECT",
  "KEEPA_REQUESTED_ASIN_MISSING",
  "KEEPA_UNVERIFIED_SUSPICIOUS_STATE",
  "NO_TRUSTED_REFERENCE",
] as const

export type KeepaVerifyPrimaryCode = (typeof KEEPA_VERIFY_PRIMARY_CODES)[number]

const PRIMARY_SET = new Set<string>(KEEPA_VERIFY_PRIMARY_CODES)
const TERMINAL_CANDIDATE = new Set(["MATCHED", "CONFLICT", "SUPERSEDED", "NO_BUSINESS_CHANGE", "COOLDOWN", "INCONCLUSIVE"])

export function shouldEnqueueKeepaVerifyPrimary(code: string | null | undefined): boolean {
  return PRIMARY_SET.has(String(code ?? "").trim().toUpperCase())
}

export function keepaVerifyCandidatePurpose(evaluationCode: string | null | undefined): string {
  return String(evaluationCode ?? "").trim().toUpperCase() === "NO_TRUSTED_REFERENCE"
    ? KEEPA_TRUSTED_BASELINE_PURPOSE
    : KEEPA_VERIFY_PURPOSE
}

export function keepaVerifyPrimaryEnqueueSlots(activeCount: number, cap = KEEPA_VERIFY_PRIMARY_ACTIVE_CAP): number {
  const active = Number.isFinite(activeCount) ? Math.max(0, Math.floor(activeCount)) : 0
  const max = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : KEEPA_VERIFY_PRIMARY_ACTIVE_CAP
  return Math.max(0, max - active)
}

export function keepaVerifyConfirmPersistMode(input: {
  purpose: string | null | undefined
  gateSkip: string | null
  allowEbayMutation: boolean
  persistObservationOnly: boolean
}): "none" | "trusted_baseline" | "ebay_apply" | "catalog_only" {
  if (input.gateSkip) return "none"
  if (String(input.purpose ?? "").trim().toUpperCase() === KEEPA_TRUSTED_BASELINE_PURPOSE) {
    return "trusted_baseline"
  }
  if (input.allowEbayMutation) return "ebay_apply"
  if (input.persistObservationOnly) return "catalog_only"
  return "none"
}

export function isKeepaVerifyCandidateTerminal(status: string | null | undefined): boolean {
  return TERMINAL_CANDIDATE.has(String(status ?? "").trim().toUpperCase())
}

export function keepaVerifyPrimaryEnqueueSkip(input: {
  enqueueEnabled: boolean
  evaluationCode: string | null | undefined
  candidateStatus: string | null | undefined
  existingPrimary: boolean
  activeJob: boolean
  duplicateAsinActive?: boolean
  trustedBaselineAlreadyExists?: boolean
}): string | null {
  if (!input.enqueueEnabled) return "KEEPA_VERIFY_ENQUEUE_DISABLED"
  if (!shouldEnqueueKeepaVerifyPrimary(input.evaluationCode)) return "CODE_NOT_PRIMARY"
  if (!input.candidateStatus) return "CANDIDATE_MISSING"
  if (isKeepaVerifyCandidateTerminal(input.candidateStatus)) return "CANDIDATE_TERMINAL"
  if (input.trustedBaselineAlreadyExists) return "TRUSTED_BASELINE_EXISTS"
  if (input.existingPrimary) return "PRIMARY_EXISTS"
  if (input.activeJob) return "ACTIVE_JOB_EXISTS"
  if (input.duplicateAsinActive) return "DUPLICATE_ASIN"
  return null
}

export type KeepaVerifyFollowUp =
  | { action: "none"; reason: string; enqueueConfirm: false; applyBrowser: false }
  | { action: "enqueue_confirm"; reason: "PRIMARY_VALID"; enqueueConfirm: true; applyBrowser: false }
  | { action: "apply_browser"; reason: "CONFIRM_MATCH"; enqueueConfirm: false; applyBrowser: true }
  | { action: "no_mutation"; reason: string; enqueueConfirm: false; applyBrowser: false }

export function decideKeepaVerifyFollowUp(input: {
  kind: string
  incomplete: boolean
  decisionOutcome: string
  fingerprintMatch: boolean
  freshnessSkip: string | null
  alreadyApplied?: boolean
}): KeepaVerifyFollowUp {
  const kind = String(input.kind ?? "")
  if (input.alreadyApplied) {
    return { action: "no_mutation", reason: "REPLAY_NO_SECOND_APPLY", enqueueConfirm: false, applyBrowser: false }
  }
  if (kind === "KEEPA_VERIFY_PRIMARY") {
    if (input.incomplete) {
      return { action: "none", reason: "PRIMARY_INCOMPLETE", enqueueConfirm: false, applyBrowser: false }
    }
    if (input.decisionOutcome === "UNKNOWN") {
      return { action: "none", reason: "PRIMARY_UNKNOWN", enqueueConfirm: false, applyBrowser: false }
    }
    if (
      input.decisionOutcome === "VALID_SOURCE" ||
      input.decisionOutcome === "CONFIRMED_NO_VALID_SOURCE" ||
      input.decisionOutcome === "SOURCE_ASIN_REDIRECTED"
    ) {
      return { action: "enqueue_confirm", reason: "PRIMARY_VALID", enqueueConfirm: true, applyBrowser: false }
    }
    return { action: "none", reason: "PRIMARY_NOT_ACTIONABLE", enqueueConfirm: false, applyBrowser: false }
  }
  if (kind === "KEEPA_VERIFY_CONFIRM") {
    if (input.incomplete) {
      return { action: "no_mutation", reason: "INCOMPLETE_NO_MUTATION", enqueueConfirm: false, applyBrowser: false }
    }
    if (input.decisionOutcome === "UNKNOWN") {
      return { action: "no_mutation", reason: "UNKNOWN_NO_MUTATION", enqueueConfirm: false, applyBrowser: false }
    }
    if (input.freshnessSkip) {
      return { action: "no_mutation", reason: input.freshnessSkip, enqueueConfirm: false, applyBrowser: false }
    }
    if (!input.fingerprintMatch) {
      return { action: "no_mutation", reason: "CONFIRM_CONFLICT", enqueueConfirm: false, applyBrowser: false }
    }
    return { action: "apply_browser", reason: "CONFIRM_MATCH", enqueueConfirm: false, applyBrowser: true }
  }
  return { action: "none", reason: "NOT_KEEPA_VERIFY", enqueueConfirm: false, applyBrowser: false }
}
