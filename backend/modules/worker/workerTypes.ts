// ─────────────────────────────────────────────────────────────
// workerTypes.ts
// ─────────────────────────────────────────────────────────────

export type WorkerStage = "scrape" | "ai" | "publish"

export type WorkerStageResult = {
  stage:      WorkerStage
  attempted:  number
  succeeded:  number
  failed:     number
  skipped:    number
  durationMs: number
}

export type WorkerRunResult = {
  workspaceId:  string
  startedAt:    string
  completedAt:  string
  totalDurationMs: number
  stages:       WorkerStageResult[]
  scrape:       WorkerStageResult
  ai:           WorkerStageResult
  publish:      WorkerStageResult
}

// Lock kaydı — workerRepository tarafından kullanılır
export type StageLock = {
  poolId:     number
  stage:      WorkerStage
  lockedAt:   string
  lockedBy:   string   // worker instance ID
}

export type AcquireLockResult = {
  acquired:  boolean
  poolId:    number
  stage:     WorkerStage
  reason?:   string
}
