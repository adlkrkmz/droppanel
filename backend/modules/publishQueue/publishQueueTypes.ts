// ─────────────────────────────────────────────────────────────
// publishQueueTypes.ts
// ─────────────────────────────────────────────────────────────

export type PublishQueueEntry = {
  poolId:          number
  asinRegistryId:  number
  asin:            string
  assignedStoreId: number
  storeCode:       string
  storeName:       string
  priority:        number
}

export type PublishItemResult = {
  poolId:        number
  asin:          string
  sku:           string
  status:        "success" | "failed" | "skipped" | "blocked"
  error:         string | null
  durationMs:    number
  guardScore:    number | null
  guardErrors:   string[]
  guardWarnings: string[]
  /** eBay listing/item id from publish success response when available */
  ebayListingId?: string | null
}

export type TimedPublishRunResult = {
  storeId:      number
  storeCode:    string
  storeName:    string
  delaySeconds: number
  dryRun:       boolean
  attempted:    number
  succeeded:    number
  failed:       number
  skipped:      number
  blocked:      number
  items:        PublishItemResult[]
  startedAt:    string
  completedAt:  string
  totalMs:      number
}

export type TitleMode = "titlebot" | "ai" | "original"

export type TimedPublishOptions = {
  storeCode:       string
  /** Preferred when provided; avoids ambiguous storeCode within a workspace. */
  storeId?:        number
  workspaceId:     string
  delaySeconds:    number
  limit:           number
  dryRun:          boolean
  quantity?:       number
  ebayOauthToken:  string
  ebaySandbox:     boolean
  simulationMode:  boolean
  titleMode?:      TitleMode
  // Listing run akışında dispatch edilen poolId'leri doğrudan hedefle.
  // Verilirse fetchPublishQueueForStore atlanır, sadece bu ID'ler işlenir.
  targetPoolIds?:  number[]
  /** e.g. scheduled_live_single_job — enforces single-pool publish safety */
  source?:         string
  /** Direct List retains the pool for a fresh capture retry on availability failure. */
  archiveAvailabilityFailures?: boolean
  /** Direct List only: unknown stock is observable but not a stock block. */
  allowUnknownStockForDirectList?: boolean
  promotion?: {
    enabled?: boolean
    adRatePercent?: number | null
    adFeeTaxPercent?: number | null
  } | null
}
