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
  id: number
  /** Stable store identity (same as id); preferred by extension clients. */
  storeId: number
  name: string
  storeCode: string
  status: string
  createdAt: string
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

export type PoolView =
  | "active"
  | "ready"
  | "processing"
  | "assigned"
  | "failed"
  | "history"
  | "archived"
  | "all"

export type AdminPoolRow = {
  poolId: number; asin: string; title: string | null; brand: string | null
  amazonCost: number | null; pipelineStage: string; status: string
  scrapeStatus: string; aiStatus: string; listingStatus: string
  assignedStoreId: number | null; assignedStoreCode: string | null
  assignedStoreName: string | null; createdAt: string; updatedAt: string
  archivedAt: string | null; archivedBy: string | null; archiveReason: string | null
}

export type AdminPoolResult = {
  rows: AdminPoolRow[]; total: number
  filters: {
    view:      PoolView | null
    stage:     string | null
    status:    string | null
    storeCode: string | null
  }
  generatedAt: string
}

export type PoolEligibilitySkipDetail = {
  poolId: number
  asin?:  string | null
  reason: string
}

export type TitleMode = "titlebot" | "ai" | "original"

export type AdminPoolDispatchRequest  = {
  storeCode: string
  poolIds?:  number[]
  asins?:    string[]
  delaySeconds?: number
  titleMode?: TitleMode
}
export type AdminPoolDispatchResponse = {
  selectedCount:   number
  skippedCount:    number
  assignedPoolIds: number[]
  skipDetails?:    PoolEligibilitySkipDetail[]
  poolSkipped?:    number
  poolSkipDetails?: PoolEligibilitySkipDetail[]
}

// ─── POOL RESTORE ─────────────────────────────────────────────

export type AdminPoolRestoreRequest = { poolIds: number[]; reason?: string }

export type AdminPoolRestoreItemResult = {
  poolId:  number
  ok:      boolean
  message?: string
}

export type AdminPoolRestoreResponse = {
  ok:       boolean
  restored: number
  failed:   number
  results?: AdminPoolRestoreItemResult[]
}

// ─── POOL DELETE (bulk) ─────────────────────────────────────

export type AdminPoolDeleteRequest = { poolIds: number[]; reason?: string }

export type AdminPoolArchiveItemResult = {
  poolId:  number
  ok:      boolean
  message?: string
}

export type AdminPoolDeleteResponse = {
  ok:       boolean
  archived: number
  failed:   number
  /** @deprecated use archived — kept for backward compatibility */
  deleted:  number
  results?: AdminPoolArchiveItemResult[]
}

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
  titleMode?:     TitleMode
  useAiTitle?:    boolean
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
  poolSkipped?:   number
  poolSkipDetails?: PoolEligibilitySkipDetail[]
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
  titleMode?: TitleMode
  useAiTitle?: boolean
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
  poolSkipped?:   number
  poolSkipDetails?: PoolEligibilitySkipDetail[]
  startedAt: string; completedAt: string; totalMs: number
}

// ─── SCHEDULED PUBLISH (re-export) ────────────────────────────

export type {
  ScheduledPublishCommand,
  ScheduledPublishJob,
  SchedulePublishRequest,
  SchedulePublishResponse,
  ScheduleCommandListResponse,
  ScheduleJobListResponse,
  ScheduleCommandActionResponse,
  ScheduleCommandDetailResponse,
  ScheduleSkipDetail,
  ScheduleJobProgress,
} from "../scheduledPublish/scheduledPublishTypes"

// ─── REQUEST BASE ─────────────────────────────────────────────

export type AdminRequest = {
  query:   Record<string, string | undefined>
  params:  Record<string, string | undefined>
  body:    unknown
  traceId?: string
}

export type AdminResponse<T> = {
  status: number
  body:   T | AdminErrorBody
}

export type AdminErrorBody = { error: string; message: string }
