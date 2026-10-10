export type StockGuardMode = "manual" | "auto"

export type StockGuardSettingsRow = {
  id: number
  workspaceId: string
  storeId: number
  enabled: boolean
  mode: StockGuardMode
  priceAlertEnabled: boolean
  priceIncreasePercentThreshold: number
  priceIncreaseAmountThreshold: number
  soldScanHours: number
  clickedScanHours: number
  normalScanHours: number
  autoZeroNoPriceRequiresRepeat: boolean
  autoProfitProtectionEnabled: boolean
}

export type ScanJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped_waiting_tokens"

export type SourceCheckPriority = "sold" | "clicked" | "normal"

export type CatalogSourceStatus =
  | "AMAZON_OK"
  | "NO_PRICE"
  | "UNAVAILABLE"
  | "REMOVED"
  | "CHECK_FAILED"
  | "PRICE_INCREASE"
  | "PRICE_UNCERTAIN"

export const RISK_STATUSES: CatalogSourceStatus[] = [
  "NO_PRICE",
  "UNAVAILABLE",
  "REMOVED",
  "PRICE_INCREASE",
  "PRICE_UNCERTAIN",
]

export type StockGuardStatusResponse = {
  ok: true
  keepaEnabled: boolean
  /** Effective tokens after refill estimate (backward compatible). */
  tokensLeft: number | null
  tokensLeftRaw: number | null
  tokensLeftEffective: number | null
  tokensUpdatedAt: string | null
  refillRatePerMinute: number
  bucketCapacity: number
  reserveTokens: number
  /** false when keepa_token_state has never been updated (unknown). */
  tokensKnown: boolean
  stores: Array<{
    storeCode: string
    storeId: number
    enabled: boolean
    mode: StockGuardMode
    pendingJobs: number
    runningJobs: number
    skippedWaitingTokens: number
    nextScheduledAt: string | null
    dueNowCount: number
    lastCompletedAt: string | null
    pendingAlerts: number
    analyticsScopeActive: boolean
    clicks30dLastSyncAt: string | null
    clicks30dNextSyncAt: string | null
    clicks30dSyncStatus: string | null
    clicks30dSyncError: string | null
    lastCheckedCount: number | null
    lastUpdatedCount: number | null
  }>
  clicks30dAutoSync: Array<{
    storeCode: string
    analyticsScopeActive: boolean
    clicks30dLastSyncAt: string | null
    clicks30dNextSyncAt: string | null
    clicks30dSyncStatus: string | null
    clicks30dSyncError: string | null
    lastCheckedCount: number | null
    lastUpdatedCount: number | null
  }>
  jobs: {
    queued: number
    running: number
    skippedWaitingTokens: number
    staleRecoveredLastRun: number
  }
}
