import { loadGlobalKeepaFoundationConfig } from "./globalKeepaConfig"
import { runGlobalKeepaPlannerTick } from "./globalKeepaPlannerTick"

let timer: NodeJS.Timeout | null = null
let tickInProgress = false

/**
 * Platform planner loop. No-op unless GLOBAL_KEEPA_PLANNER_ENABLED=true.
 * Does not start a 10k production drain by default (flags false).
 */
export function startGlobalKeepaPlannerScheduler(): void {
  const keepaOn = (process.env.KEEPA_ENABLED ?? "").trim().replace(/^"|"$/g, "").toLowerCase() === "true"
  const cfg = loadGlobalKeepaFoundationConfig()
  if (!keepaOn || !cfg.plannerEnabled || !cfg.monitorEnabled) {
    console.log("[Keepa] disabled — planner/monitor/timer/API client off")
    return
  }
  if ((process.env.GLOBAL_KEEPA_CONTROLLED_RUN ?? "").trim().toLowerCase() === "true") {
    console.log("[GlobalKeepaPlanner] controlled run — auto ticks skipped")
    return
  }
  if (timer) return
  const tick = (): void => {
    if (tickInProgress) {
      console.warn("[GlobalKeepaPlanner] tick skipped — previous run still in progress")
      return
    }
    tickInProgress = true
    void runGlobalKeepaPlannerTick().then(
      result => {
        if (result.skipped) {
          console.log(
            `[GlobalKeepaPlanner] tick skipped=${result.skipped} mode=${result.throttleMode ?? "-"} tokensLeft=${result.tokensLeft ?? "-"} refillRate=${result.refillRate ?? "-"}`
          )
          return
        }
        console.log("[GlobalKeepaPlanner] tick", result)
      },
      err => console.error("[GlobalKeepaPlanner] tick failed:", err instanceof Error ? err.message : err)
    ).finally(() => {
      tickInProgress = false
    })
  }
  timer = setInterval(tick, cfg.tickIntervalMs)
  console.log(`[GlobalKeepaPlanner] started intervalMs=${cfg.tickIntervalMs} live=${cfg.monitorEnabled}`)
}
