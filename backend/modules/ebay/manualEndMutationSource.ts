const SOURCE_ENV = "EBAY_LIVE_MANUAL_END_ENABLED"

/** Manual End is independently gated; this must not enable automatic quantity or price mutations. */
export function isManualEndMutationEnabled(): boolean {
  return (process.env[SOURCE_ENV] ?? "").trim().toLowerCase() === "true"
}

export function manualEndMutationDisabledMessage(): string {
  return "eBay manual listing end is disabled"
}
