export const OXYLABS_VERIFY_PROTOCOL_FLAG = "OXYLABS_VERIFY_PROTOCOL_ENABLED"
export const OXYLABS_VERIFY_ENQUEUE_FLAG = "OXYLABS_VERIFY_ENQUEUE_ENABLED"
export const OXYLABS_VERIFY_CLAIM_FLAG = "OXYLABS_VERIFY_CLAIM_ENABLED"
export const OXYLABS_VERIFY_APPLY_PROCESSOR_FLAG = "OXYLABS_VERIFY_APPLY_PROCESSOR_ENABLED"
export const OXYLABS_VERIFY_MUTATIONS_FLAG = "OXYLABS_VERIFY_MUTATIONS_ENABLED"
export const OXYLABS_CANARY_MAX_SUCCESS_FLAG = "OXYLABS_CANARY_MAX_SUCCESS_RESULTS"
export const OXYLABS_PLAN_MODE_FLAG = "OXYLABS_PLAN_MODE"
export const OXYLABS_MONTHLY_RESULT_LIMIT_FLAG = "OXYLABS_MONTHLY_RESULT_LIMIT"
export const OXYLABS_BILLING_CYCLE_ANCHOR_FLAG = "OXYLABS_BILLING_CYCLE_ANCHOR_AT"
export const OXYLABS_PRODUCT_SOURCE = "amazon_product"
export const OXYLABS_PRODUCT_GEO = "10001"
export const OXYLABS_VERIFY_CONFIRM_MAX_AGE_MS = 600_000

function envFlag(name: string): boolean {
  return String(process.env[name] ?? "").trim().toLowerCase() === "true"
}

function envInt(name: string, fallback: number, max: number): number {
  const n = parseInt(process.env[name] ?? "", 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, n)
}

export type OxylabsPlanMode = "paid" | "canary"

export type OxylabsVerifyConfig = {
  protocolEnabled: boolean
  enqueueEnabled: boolean
  claimEnabled: boolean
  applyProcessorEnabled: boolean
  mutationsEnabled: boolean
  canaryMaxSuccessResults: number
  planMode: OxylabsPlanMode
  monthlyResultLimit: number
  billingCycleAnchorAt: Date | null
  geoLocation: string
  source: string
}

export function parseOxylabsPlanMode(raw = process.env.OXYLABS_PLAN_MODE): OxylabsPlanMode {
  return String(raw ?? "").trim().toLowerCase() === "paid" ? "paid" : "canary"
}

export function parseOxylabsBillingAnchor(raw = process.env.OXYLABS_BILLING_CYCLE_ANCHOR_AT): Date | null {
  const s = String(raw ?? "").trim()
  if (!s) return null
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return null
  return new Date(t)
}

export function loadOxylabsVerifyConfig(): OxylabsVerifyConfig {
  const planMode = parseOxylabsPlanMode()
  return {
    protocolEnabled: envFlag(OXYLABS_VERIFY_PROTOCOL_FLAG),
    enqueueEnabled: envFlag(OXYLABS_VERIFY_ENQUEUE_FLAG),
    claimEnabled: envFlag(OXYLABS_VERIFY_CLAIM_FLAG),
    applyProcessorEnabled: envFlag(OXYLABS_VERIFY_APPLY_PROCESSOR_FLAG),
    mutationsEnabled: envFlag(OXYLABS_VERIFY_MUTATIONS_FLAG),
    canaryMaxSuccessResults: envInt(OXYLABS_CANARY_MAX_SUCCESS_FLAG, 20, 2000),
    planMode,
    monthlyResultLimit: envInt(OXYLABS_MONTHLY_RESULT_LIMIT_FLAG, 98000, 98000),
    billingCycleAnchorAt: parseOxylabsBillingAnchor(),
    geoLocation: OXYLABS_PRODUCT_GEO,
    source: OXYLABS_PRODUCT_SOURCE,
  }
}

export function oxylabsPricingForbidden(raw = process.env.OXYLABS_PRICING_ENABLED): boolean {
  return String(raw ?? "").trim().toLowerCase() === "true"
}
