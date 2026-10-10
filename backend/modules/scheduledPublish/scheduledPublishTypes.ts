// ----------------------------------------------------------------
// scheduledPublishTypes.ts
// ----------------------------------------------------------------

export type ScheduleSelectionMode = "ready_next" | "selected"

export type ScheduleExecutionMode = "simulation" | "live"

export type ScheduleCommandStatus =
  | "scheduled"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"

export type ScheduleJobStatus =
  | "scheduled"
  | "running"
  | "simulated"
  | "published"
  | "failed"
  | "cancelled"
  | "skipped"

export type ScheduleSkipReason =
  | "POOL_ITEM_ARCHIVED"
  | "POOL_ITEM_ARCHIVED_NOT_ELIGIBLE"
  | "POOL_ITEM_ALREADY_LISTED"
  | "POOL_ITEM_COMPLETED"
  | "POOL_ITEM_SUCCESS"
  | "POOL_ITEM_NOT_FOUND"
  | "POOL_ITEM_MISSING_OR_DELETED"
  | "POOL_ITEM_NOT_ELIGIBLE"
  | "POOL_ITEM_ALREADY_QUEUED"
  | "STORE_CONFLICT"
  | "NOT_READY"
  | "NOT_PRIME"
  | "OUT_OF_STOCK"
  | "LIMITED_STOCK"
  | "NO_VALID_PRICE"
  | "NEEDS_AMAZON_VALIDATION"
  | "PRIME_UNKNOWN"
  | "STOCK_UNKNOWN"

export type ScheduleSkipDetail = {
  poolId?: number
  asin?:   string | null
  reason:  ScheduleSkipReason | string
}

export type QuickDispatchEvidenceGateSummary = {
  requestedCount:       number
  readyForPublishCount: number
  captureRequiredCount: number
  skippedCount:         number
  publishCommandId:     number | null
  captureCommandId:     number | null
  message:              string
}

export type SchedulePublishRequest = {
  storeCode:        string
  selectionMode:    ScheduleSelectionMode
  poolIds?:         number[]
  count:            number
  startAt:          string
  intervalSeconds:  number
  quantity?:        number
  titleMode?:       "titlebot" | "ai" | "original"
  title?:           string
  executionMode?:   ScheduleExecutionMode
  confirm?:         boolean
  confirmationText?: string
  evidenceGate?:    boolean
}

export type ScheduleJobProgress = {
  scheduled:  number
  running:    number
  simulated:  number
  published:  number
  failed:     number
  cancelled:  number
  skipped:    number
  total:      number
}

export type ScheduledPublishCommand = {
  id:               number
  storeCode:        string
  title:            string | null
  status:           ScheduleCommandStatus
  selectionMode:    string
  requestedCount:   number
  eligibleCount:    number
  skippedCount:     number
  createdJobCount:  number
  startAt:          string
  intervalSeconds:  number
  quantity:         number
  titleMode:        string
  executionMode:    ScheduleExecutionMode
  createdAt:        string
  updatedAt:        string
  pausedAt:         string | null
  cancelledAt:      string | null
  completedAt:      string | null
  lastError:        string | null
  metadata:         Record<string, unknown>
  progress?:        ScheduleJobProgress
}

export type ScheduledPublishJob = {
  id:            number
  commandId:     number
  poolId:        number
  asin:          string | null
  scheduledAt:   string
  status:        ScheduleJobStatus
  attemptCount:  number
  errorMessage:  string | null
  publishedAt:   string | null
  failedAt:      string | null
  cancelledAt:   string | null
}

export type SchedulePublishResponse = {
  ok:              boolean
  command?:        ScheduledPublishCommand
  skipDetails?:    ScheduleSkipDetail[]
  evidenceGate?:   QuickDispatchEvidenceGateSummary
}

export type ScheduleCommandListResponse = {
  ok:       boolean
  page:     number
  limit:    number
  total:    number
  commands: ScheduledPublishCommand[]
}

export type ScheduleCommandDetailResponse = {
  ok:          boolean
  command:     ScheduledPublishCommand
  skipDetails?: ScheduleSkipDetail[]
  recentJobs?: ScheduledPublishJob[]
}

export type ScheduleJobListResponse = {
  ok:       boolean
  command:  ScheduledPublishCommand
  page:     number
  limit:    number
  total:    number
  jobs:     ScheduledPublishJob[]
}

export type ScheduleCommandActionResponse = {
  ok:      boolean
  command: ScheduledPublishCommand
}

export type ScheduledRunnerRunDueRequest = {
  limit?:     number
  storeCode?: string
}

export type ScheduledRunnerResult = {
  jobId:     number
  commandId: number
  poolId:    number
  asin?:     string | null
  ok:        boolean
  status:    string
  message?:  string
}

export type ScheduledRunnerRunDueResponse = {
  ok:              boolean
  mode:            "simulation"
  requestedLimit:  number
  processed:       number
  simulated:       number
  failed:          number
  skipped:         number
  results:         ScheduledRunnerResult[]
}

export type ScheduledSimulationAutoRunnerLastResult = {
  processed: number
  simulated: number
  skipped:   number
  failed:    number
}

export type ScheduledSimulationAutoRunnerStatus = {
  enabled:        boolean
  running:        boolean
  intervalMs:     number
  tickInProgress: boolean
  lastTickAt:     string | null
  lastResult:     ScheduledSimulationAutoRunnerLastResult | null
  lastError:      string | null
}

export type ScheduledRunnerStatusResponse = {
  ok:               boolean
  simulationRunner: ScheduledSimulationAutoRunnerStatus
}

export type ScheduledLiveRunnerRequest = {
  storeCode?:         string
  commandId?:         number
  confirm?:           boolean
  confirmationText?:  string
}

export type ScheduledLiveRunnerResult = {
  jobId?:      number
  commandId?:  number
  poolId?:     number
  asin?:       string | null
  status?:     string
  ebayItemId?: string | null
  message?:    string
  error?:      string
  promotion?:  {
    requested: boolean
    requestedRate: number | null
    status: string
    effectiveRate: number | null
    campaignId: string | null
    adId: string | null
    code: string | null
    message: string
    retryable: boolean
  } | null
}

export type ScheduledLiveRunnerRunResponse = {
  ok:        boolean
  mode:      "live"
  processed: number
  published: number
  failed:    number
  skipped:   number
  message?:  string
  result?:   ScheduledLiveRunnerResult | null
}
