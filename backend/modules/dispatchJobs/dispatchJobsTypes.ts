export type DispatchRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export type DispatchJobStatus =
  | "pending"
  | "claimed"
  | "extract_running"
  | "extract_done"
  | "ai_running"
  | "ai_done"
  | "listing_running"
  | "listing_done"
  | "failed"
  | "retry_waiting"
  | "cancelled"

export type DispatchFailedStage =
  | "extract"
  | "ai"
  | "listing"
  | "claim"
  | "unknown"

export type DispatchRun = {
  id: number
  workspaceId: string
  storeId: number
  storeCode: string
  delaySeconds: number
  quantity: number
  status: DispatchRunStatus
  totalJobs: number
  completedJobs: number
  failedJobs: number
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  updatedAt: string
}

export type DispatchJobType =
  | "scrape_and_list"  // validated — worker: scrape + AI + done
  | "ai_and_list"      // scraped   — worker: sadece AI + done
  | "list_only"        // ai_generated — worker: direkt done (listing panel yapar)

export type DispatchJob = {
  id: number
  runId: number
  workspaceId: string
  storeId: number
  storeCode: string
  asin: string
  poolId: number | null
  jobType: DispatchJobType
  status: DispatchJobStatus
  quantity: number
  delaySeconds: number
  attemptCount: number
  maxAttempts: number
  lastError: string | null
  failedStage: DispatchFailedStage | null
  workerId: string | null
  claimedAt: string | null
  startedAt: string | null
  completedAt: string | null
  nextRetryAt: string | null
  createdAt: string
  updatedAt: string
}

export type ClaimNextJobResult = {
  job: DispatchJob | null
}

export type CreateRunRequest = {
  workspaceId: string
  storeCode: string
  quantity: number
  delaySeconds: number
  poolIds: number[]
}

/** Worker → backend: 60s job timeout gibi sınıflandırma (mesaj dışı). */
export type DispatchJobFailureKind = "job_timeout"

export type ReportJobRequest = {
  jobId: number
  workerId: string
  status: DispatchJobStatus
  error?: string
  failedStage?: DispatchFailedStage
  failureKind?: DispatchJobFailureKind
}

export type RunStatusResult = {
  run: DispatchRun | null
  summary: {
    pending: number
    claimed: number
    extract_running: number
    extract_done: number
    ai_running: number
    ai_done: number
    listing_running: number
    listing_done: number
    failed: number
    retry_waiting: number
    cancelled: number
    total: number
  }
  jobs: DispatchJob[]
}
