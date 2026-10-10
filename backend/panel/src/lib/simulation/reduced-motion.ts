import { MOBILE_SCANNER_DURATION_MS, SCANNER_DURATION_MS } from './constants'

/** True when user prefers reduced motion (SSR-safe: false on server). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Scanner duration respecting reduced motion and viewport. */
export function getScannerDurationMs(options?: {
  isMobile?: boolean
  respectReducedMotion?: boolean
}): number {
  const { isMobile = false, respectReducedMotion = true } = options ?? {}
  if (respectReducedMotion && prefersReducedMotion()) {
    return 0
  }
  return isMobile ? MOBILE_SCANNER_DURATION_MS : SCANNER_DURATION_MS
}

/** Scale a timeline offset when reduced motion: snap to end state. */
export function resolveMotionTimelineMs(
  offsetMs: number,
  totalMs: number,
  respectReducedMotion = true
): number {
  if (respectReducedMotion && prefersReducedMotion()) {
    return totalMs
  }
  return offsetMs
}
