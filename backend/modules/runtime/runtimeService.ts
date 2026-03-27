// ─────────────────────────────────────────────────────────────
// runtimeService.ts
//
// startWorkerLoop() — Worker'ı belirli aralıklarla çalıştırır.
//
// Garantiler:
//   - Aynı anda yalnızca bir tur çalışır (in-memory guard)
//   - Tur bitmeden yeni tur başlamaz
//   - stopWorkerLoop() çağrıldığında mevcut tur biter, yeni tur başlamaz
//   - SIGINT / SIGTERM sinyallerini dışarıdan handle edebilmek için
//     stop fonksiyonu return edilir
// ─────────────────────────────────────────────────────────────

import { runWorker } from "../worker/workerService"
import type { WorkerRunOptions } from "../worker/workerService"
import type {
  LoopState,
  LoopTurnSummary,
  WorkerLoopOptions
} from "./runtimeTypes"

const DEFAULT_INTERVAL_MS  = 30_000
const DEFAULT_HISTORY_LIMIT = 20
const DEFAULT_MAX_TURNS     = 0        // 0 = sonsuz

// ─── MODULE-LEVEL STATE ───────────────────────────────────────
// Her process'te tek bir loop instance çalışır.

let _state: LoopState = {
  status:     "idle",
  turn:       0,
  startedAt:  null,
  lastTurnAt: null,
  history:    []
}

let _stopRequested = false
let _loopRunning   = false   // tur-içi guard

// ─── STATE ACCESSOR ───────────────────────────────────────────

export function getLoopState(): Readonly<LoopState> {
  return _state
}

// ─── STOP ─────────────────────────────────────────────────────

export function stopWorkerLoop(): void {
  if (_state.status === "stopped") return
  _stopRequested   = true
  _state.status    = "stopped"
  console.log("[Loop] Stop requested — current turn will finish, then loop exits")
}

// ─── SINGLE TURN ──────────────────────────────────────────────

async function runOneTurn(
  workspaceId: string,
  workerOpts:  WorkerRunOptions,
  turnNumber:  number
): Promise<LoopTurnSummary> {
  const startedAt = new Date().toISOString()
  const t0        = Date.now()
  let   error: string | null = null

  console.log(`\n[Loop] ── Turn ${turnNumber} starting ── ${startedAt}`)

  let scrapeSucceeded  = 0
  let aiSucceeded      = 0
  let publishSucceeded = 0

  try {
    const result = await runWorker(workspaceId, workerOpts)
    scrapeSucceeded  = result.scrape.succeeded
    aiSucceeded      = result.ai.succeeded
    publishSucceeded = result.publish.succeeded
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    console.error(`[Loop] Turn ${turnNumber} threw an error: ${error}`)
  }

  const completedAt = new Date().toISOString()
  const durationMs  = Date.now() - t0

  console.log(
    `[Loop] ── Turn ${turnNumber} done ── ` +
    `scrape=${scrapeSucceeded} ai=${aiSucceeded} publish=${publishSucceeded} ` +
    `duration=${durationMs}ms${error ? ` ERROR=${error}` : ""}`
  )

  return {
    turn: turnNumber,
    startedAt,
    completedAt,
    durationMs,
    scrapeSucceeded,
    aiSucceeded,
    publishSucceeded,
    error
  }
}

// ─── MAIN LOOP ────────────────────────────────────────────────

export async function startWorkerLoop(
  workspaceId: string,
  options: WorkerLoopOptions = {}
): Promise<() => void> {
  if (_state.status === "running") {
    console.warn("[Loop] Already running — ignoring duplicate startWorkerLoop() call")
    return stopWorkerLoop
  }

  const intervalMs   = options.intervalMs   ?? DEFAULT_INTERVAL_MS
  const maxTurns     = options.maxTurns     ?? DEFAULT_MAX_TURNS
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT

  const workerOpts: WorkerRunOptions = {
    scrapeLimit:    options.scrapeLimit,
    aiLimit:        options.aiLimit,
    publishLimit:   options.publishLimit,
    publishDelayMs: options.publishDelayMs,
    ebayOauthToken: options.ebayOauthToken,
    ebaySandbox:    options.ebaySandbox,
    simulationMode: options.simulationMode
  }

  _stopRequested = false
  _loopRunning   = false

  _state = {
    status:     "running",
    turn:       0,
    startedAt:  new Date().toISOString(),
    lastTurnAt: null,
    history:    []
  }

  console.log(
    `[Loop] Starting | workspace=${workspaceId} ` +
    `interval=${intervalMs}ms ` +
    `maxTurns=${maxTurns === 0 ? "∞" : maxTurns}`
  )

  // Async loop — iç promise, caller'ı bloklamaz
  const loopPromise = (async () => {
    while (!_stopRequested) {
      // Tur-içi guard — paralel çalışmayı engeller
      if (_loopRunning) {
        await sleep(500)
        continue
      }

      _loopRunning = true
      _state.turn += 1
      const currentTurn = _state.turn

      const summary = await runOneTurn(workspaceId, workerOpts, currentTurn)

      _state.lastTurnAt = summary.completedAt
      _state.history.push(summary)

      // Geçmiş sınırla
      if (_state.history.length > historyLimit) {
        _state.history.splice(0, _state.history.length - historyLimit)
      }

      _loopRunning = false

      // maxTurns kontrolü
      if (maxTurns > 0 && _state.turn >= maxTurns) {
        console.log(`[Loop] maxTurns=${maxTurns} reached — stopping`)
        _stopRequested = true
        break
      }

      if (_stopRequested) break

      // Sonraki tura kadar bekle
      console.log(`[Loop] Sleeping ${intervalMs}ms until next turn...`)
      await sleep(intervalMs)
    }

    _state.status = "stopped"
    console.log("[Loop] Exited cleanly")
  })()

  // Unhandled rejection'ı yakala
  loopPromise.catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[Loop] Fatal error in loop: ${msg}`)
    _state.status = "stopped"
  })

  return stopWorkerLoop
}

// ─── YARDIMCI ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
