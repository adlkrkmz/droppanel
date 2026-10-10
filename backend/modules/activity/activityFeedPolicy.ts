export const PRIMARY_FEED_EVENT_TYPES = [
  "VERIFICATION_QUEUED",
  "PRICE_APPROVAL_REQUIRED",
  "PRICE_PROTECTION_APPLIED",
  "STOCK_ZEROED",
  "SOURCE_ASIN_REDIRECTED",
  "SOURCE_RESTORED",
  "STOCK_ZERO_FAILED",
  "ACTION_FAILED",
] as const

export type PrimaryFeedEventType = (typeof PRIMARY_FEED_EVENT_TYPES)[number]

const PRIMARY_SET = new Set<string>(PRIMARY_FEED_EVENT_TYPES)

export function isPrimaryFeedEventType(eventType: string | null | undefined): boolean {
  return PRIMARY_SET.has(String(eventType ?? "").trim())
}

export function isNoOpVerifiedPlanAction(planAction: string | null | undefined): boolean {
  const a = String(planAction ?? "").trim()
  return (
    a === "none" ||
    a === "verified_ok" ||
    a === "idempotent" ||
    a === "profit_protection_skipped" ||
    a === "profit_protection_no_raise"
  )
}

export function isVisibleInPrimaryFeed(input: { createdAt: Date; now: Date; visibleUntil?: Date | null }): boolean {
  const ageMs = input.now.getTime() - input.createdAt.getTime()
  if (ageMs > 24 * 60 * 60 * 1000) return false
  if (input.visibleUntil && input.visibleUntil.getTime() <= input.now.getTime()) return false
  return true
}
