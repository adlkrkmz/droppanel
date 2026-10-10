/**
 * Cleanup-safe timer helpers for simulation loops (homepage Phase S+).
 */

export type TimeoutHandle = ReturnType<typeof setTimeout>
export type IntervalHandle = ReturnType<typeof setInterval>

export function createTimeout(callback: () => void, ms: number): TimeoutHandle {
  return setTimeout(callback, ms)
}

export function createInterval(callback: () => void, ms: number): IntervalHandle {
  return setInterval(callback, ms)
}

export function clearTimeoutSafe(handle: TimeoutHandle | null | undefined): void {
  if (handle != null) clearTimeout(handle)
}

export function clearIntervalSafe(handle: IntervalHandle | null | undefined): void {
  if (handle != null) clearInterval(handle)
}

/** Registry for batch cleanup on unmount. */
export function createTimerRegistry() {
  const timeouts = new Set<TimeoutHandle>()
  const intervals = new Set<IntervalHandle>()

  return {
    setTimeout(callback: () => void, ms: number) {
      const id = createTimeout(() => {
        timeouts.delete(id)
        callback()
      }, ms)
      timeouts.add(id)
      return id
    },
    setInterval(callback: () => void, ms: number) {
      const id = createInterval(callback, ms)
      intervals.add(id)
      return id
    },
    clearAll() {
      timeouts.forEach((id) => clearTimeout(id))
      intervals.forEach((id) => clearInterval(id))
      timeouts.clear()
      intervals.clear()
    },
  }
}
