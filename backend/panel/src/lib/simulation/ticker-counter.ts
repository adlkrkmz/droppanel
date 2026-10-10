import { TICKER_DEFAULT_STEP_MS } from './constants'
import { prefersReducedMotion } from './reduced-motion'
import { createTimerRegistry } from './timers'

export type TickerCounterOptions = {
  from: number
  to: number
  durationMs: number
  stepMs?: number
  onUpdate: (value: number) => void
  onComplete?: () => void
  easing?: (t: number) => number
}

const defaultEasing = (t: number) => 1 - Math.pow(1 - t, 3)

/**
 * Animates an integer counter; returns cleanup.
 * Snaps to `to` immediately when reduced motion is preferred.
 */
export function runTickerCounter(options: TickerCounterOptions): () => void {
  const {
    from,
    to,
    durationMs,
    stepMs = TICKER_DEFAULT_STEP_MS,
    onUpdate,
    onComplete,
    easing = defaultEasing,
  } = options

  const registry = createTimerRegistry()

  if (prefersReducedMotion() || durationMs <= 0) {
    onUpdate(to)
    onComplete?.()
    return () => registry.clearAll()
  }

  const start = Date.now()
  onUpdate(from)

  registry.setInterval(() => {
    const elapsed = Date.now() - start
    const t = Math.min(1, elapsed / durationMs)
    const value = Math.round(from + (to - from) * easing(t))
    onUpdate(value)
    if (t >= 1) {
      registry.clearAll()
      onComplete?.()
    }
  }, stepMs)

  return () => registry.clearAll()
}
