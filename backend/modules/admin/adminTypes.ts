// ─────────────────────────────────────────────────────────────
// adminTypes.ts
// ─────────────────────────────────────────────────────────────

import type {
  DispatchRun,
  DispatchJob,
  DispatchJobStatus,
  DispatchFailedStage,
  ClaimNextJobResult,
  ReportJobRequest,
} from "../dispatchJobs/dispatchJobsTypes"

export type PipelineStageCounts = {
  validated: number; scraped: number; ai_generated: number; listed: number
}

export type DashboardSummary = {
  asinRegistryTotal: number; asinPoolTotal: number
  poolReady: number; poolCompleted: number
  pipelineStages: PipelineStageCounts
  storesTotal: number; storesActive: number; generatedAt: string
}

export type AdminQueueSummary = {
  scrapeQueueCount: number; aiQueueCount: number
  publishQueueCount: number; total: number; generatedAt: string
}

export type AdminListingHistoryRow = {
  id: number; asin: string; internalSku: string | null
  ebayItemId: string | null; storeName: string | null
  status: string; listedAt: string | null; createdAt: string
}

export type AdminListingHistoryResult = {
  rows: AdminListingHistoryRow[]; total: number; generatedAt: string
}

export type AdminStoreRow = {
  id: number; name: string; storeCode: string; status: string; createdAt: string
}

export type AdminCreateStoreRequest = {
  name: string
  storeCode: string
}

export type AdminCreateStoreResponse = AdminStoreRow

export type AdminStoresResult = {
  rows: AdminStoreRow[]; total: number; generatedAt: string
}

// ─── POOL ─────────────────────────────────────────────────────

export type AdminPoolRow = {
  poolId: number; asin: string; title: string | null; brand: string | null
  amazonCost: number | null; pipelineStage: string; status: string
  scrapeStatus: string; aiStatus: string; listingStatus: string
  assignedStoreId: number | null; assignedStoreCode: string | null
  assignedStoreName: string | null; updatedAt: string
}

export type AdminPoolResult = {
  rows: AdminPoolRow[]; total: number
  filters: { stage: string | null; status: string | null; storeCode: string | null }
  generatedAt: string
}

export type AdminPoolDispatchRequest  = { storeCode: string; poolIds: number[]; delaySeconds?: number }
export type AdminPoolDispatchResponse = { selectedCount: number; skippedCount: number; assignedPoolIds: number[] }

// ─── POOL DELETE (bulk) ─────────────────────────────────────

export type AdminPoolDeleteRequest = { poolIds: number[] }
export type AdminPoolDeleteResponse = { deleted: number }

// ─── LISTING RUN (single operation: dispatch + publish) ────────

// ─── DISPATCH RUNS / JOBS (worker system) ──────────────────────

export type DispatchRunCreateRequest = {
  storeCode: string
  poolIds: number[]
  quantity: number
  delaySeconds: number
}

export type DispatchRunCreateResponse = DispatchRun

export type DispatchJobClaimRequest = {
  workerId: string
  storeCode: string
}

export type DispatchJobClaimResponse = ClaimNextJobResult

export type DispatchJobReportRequest = {
  jobId: number
  workerId: string
  status: DispatchJobStatus
  error?: string
  failedStage?: DispatchFailedStage
  failureKind?: "job_timeout"
}

export type DispatchJobReportResponse = { ok: true }

export type AdminListingRunRequest = {
  storeCode:      string
  count:          number
  selectionMode:  "random" | "priority" | "fifo"
  delaySeconds:   number
  quantity:       number
  dryRun?:        boolean
  simulationMode?: boolean
  poolIds?:       number[]
}

export type AdminListingRunDispatchSummary = {
  selectedCount:   number
  skippedCount:    number
  assignedPoolIds: number[]
  assignedAsins:   string[]
}

export type AdminListingRunPublishItem = {
  poolId:        number
  asin:          string
  sku:           string
  status:        "success" | "failed" | "skipped" | "blocked"
  error:         string | null
  guardScore:    number | null
  guardErrors:   string[]
  guardWarnings: string[]
  durationMs:    number
}

export type AdminListingRunResponse = {
  storeId:       number
  storeCode:     string
  storeName:     string
  dryRun:        boolean
  simulationMode: boolean
  dispatch: AdminListingRunDispatchSummary
  publish: {
    attempted:  number
    succeeded:  number
    failed:     number
    blocked:    number
    skipped:    number
    items:      AdminListingRunPublishItem[]
    totalMs:    number
  }
  startedAt:   string
  completedAt: string
  totalMs:     number
}

// ─── DISPATCH (raw) ───────────────────────────────────────────

export type AdminDispatchRequest = {
  storeCode: string; count: number
  selectionMode: "random" | "priority" | "fifo"; delaySeconds: number
}

export type AdminDispatchResponse = {
  storeId: number; storeCode: string; storeName: string
  selectionMode: string; delaySeconds: number
  selectedCount: number; skippedCount: number
  assignedPoolIds: number[]; assignedAsins: string[]; dispatchedAt: string
}

// ─── PUBLISH (raw) ────────────────────────────────────────────

export type AdminPublishRequest = {
  storeCode: string; delaySeconds: number; limit: number
  dryRun: boolean; simulationMode: boolean
  quantity?: number
  poolIds?: number[]
}

export type AdminPublishItemResult = {
  poolId: number; asin: string; sku: string
  status: "success" | "failed" | "skipped" | "blocked"
  error: string | null; guardScore: number | null
  guardErrors: string[]; guardWarnings: string[]; durationMs: number
}

export type AdminPublishResponse = {
  storeId: number; storeCode: string; storeName: string
  delaySeconds: number; dryRun: boolean
  attempted: number; succeeded: number; failed: number; skipped: number; blocked: number
  items: AdminPublishItemResult[]
  startedAt: string; completedAt: string; totalMs: number
}

// ─── REQUEST BASE ─────────────────────────────────────────────

export type AdminRequest = {
  query:  Record<string, string | undefined>
  params: Record<string, string | undefined>
  body:   unknown
}

export type AdminResponse<T> = {
  status: number
  body:   T | AdminErrorBody
}

export type AdminErrorBody = { error: string; message: string }
