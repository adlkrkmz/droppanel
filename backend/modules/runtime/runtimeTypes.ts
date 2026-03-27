// ─────────────────────────────────────────────────────────────
// runtimeTypes.ts
// ─────────────────────────────────────────────────────────────

export type LoopStatus = "idle" | "running" | "stopped"

export type LoopTurnSummary = {
  turn:           number
  startedAt:      string
  completedAt:    string
  durationMs:     number
  scrapeSucceeded: number
  aiSucceeded:     number
  publishSucceeded: number
  error:          string | null
}

export type LoopState = {
  status:      LoopStatus
  turn:        number
  startedAt:   string | null
  lastTurnAt:  string | null
  history:     LoopTurnSummary[]
}

export type WorkerLoopOptions = {
  intervalMs?:     number   // tur arası bekleme (default 30000)
  scrapeLimit?:    number
  aiLimit?:        number
  publishLimit?:   number
  publishDelayMs?: number
  ebayOauthToken?: string
  ebaySandbox?:    boolean
  simulationMode?: boolean
  maxTurns?:       number   // 0 = sonsuz (default)
  historyLimit?:   number   // kaç tur geçmişi tutulsun (default 20)
}
