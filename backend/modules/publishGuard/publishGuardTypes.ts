// ─────────────────────────────────────────────────────────────
// publishGuardTypes.ts
// ─────────────────────────────────────────────────────────────

import type { EbayListingPayload } from "../ebay/ebayPayloadService"
import type { StoreSettingsRow }   from "../storeSettings/storeSettingsTypes"

export type GuardInput = {
  payload:       EbayListingPayload
  storeSettings: StoreSettingsRow | null
  extra?: {
    isDuplicate?:       boolean
    isBlacklisted?:     boolean
    existsInCatalog?:   boolean
  }
}

export type GuardCheckResult = {
  field:    string
  passed:   boolean
  severity: "error" | "warning" | "info"
  message:  string
}

export type GuardResult = {
  poolId:        number
  asin:          string
  sku:           string
  isPublishable: boolean
  score:         number        // 0–100
  errors:        string[]
  warnings:      string[]
  checks:        GuardCheckResult[]
}
