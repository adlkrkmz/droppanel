// ─────────────────────────────────────────────────────────────
// schedulerTypes.ts
// ─────────────────────────────────────────────────────────────

export type SchedulerStage = "scrape" | "ai" | "publish"

// Her aşama için aday sayısı
export type QueueCounts = {
  scrapeQueueCount:  number
  aiQueueCount:      number
  publishQueueCount: number
  total:             number
}

// Tek bir aday kaydın minimal temsili
export type SchedulerCandidate = {
  poolId:          number
  asin:            string
  stage:           SchedulerStage
  priority:        number
  assignedStoreId: number | null
}

// Execution plan — şimdilik sadece sayılar, gerçek run yok
export type ExecutionPlan = {
  workspaceId:       string
  scrapeQueueCount:  number
  aiQueueCount:      number
  publishQueueCount: number
  totalQueued:       number
  generatedAt:       string   // ISO timestamp
}

// Servisin döndüğü tam özet
export type SchedulerSummary = {
  workspaceId:    string
  counts:         QueueCounts
  plan:           ExecutionPlan
  candidates:     SchedulerCandidate[]
  summaryAt:      string
}
