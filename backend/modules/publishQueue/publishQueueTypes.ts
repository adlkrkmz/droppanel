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

export type TimedPublishOptions = {
  storeCode:       string
  workspaceId:     string
  delaySeconds:    number
  limit:           number
  dryRun:          boolean
  quantity?:       number
  ebayOauthToken:  string
  ebaySandbox:     boolean
  simulationMode:  boolean
  // Listing run akışında dispatch edilen poolId'leri doğrudan hedefle.
  // Verilirse fetchPublishQueueForStore atlanır, sadece bu ID'ler işlenir.
  targetPoolIds?:  number[]
}
