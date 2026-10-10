import {
  MOBILE_SCANNER_DURATION_MS,
  SCANNER_DURATION_MS,
} from './constants'
import type { ScannerKeywordProfileId } from './scanner-keyword-profiles'

export type ScannerSequencePhaseId =
  | 'idle'
  | 'focus'
  | 'typing'
  | 'scanning'
  | 'analyzing'
  | 'results'

export type ScannerSequencePhase = {
  id: ScannerSequencePhaseId
  /** Inclusive start offset from sequence start (ms). */
  startMs: number
  /** Exclusive end offset (ms). */
  endMs: number
}

export type ScannerSequenceTimeline = {
  totalDurationMs: number
  phases: ScannerSequencePhase[]
  profileId: ScannerKeywordProfileId
}

/** Desktop phases — must sum to SCANNER_DURATION_MS (3500). */
const DESKTOP_PHASES: Omit<ScannerSequencePhase, 'startMs' | 'endMs'>[] = [
  { id: 'idle' },
  { id: 'focus' },
  { id: 'typing' },
  { id: 'scanning' },
  { id: 'analyzing' },
  { id: 'results' },
]

const DESKTOP_PHASE_BOUNDARIES_MS = [0, 200, 500, 1400, 2200, 3000, SCANNER_DURATION_MS]

/** Mobile boundaries — sum to MOBILE_SCANNER_DURATION_MS (2800). */
const MOBILE_PHASE_BOUNDARIES_MS = [0, 150, 400, 1100, 1750, 2400, MOBILE_SCANNER_DURATION_MS]

function buildPhases(boundaries: number[]): ScannerSequencePhase[] {
  const phases: ScannerSequencePhase[] = []
  for (let i = 0; i < DESKTOP_PHASES.length; i++) {
    phases.push({
      id: DESKTOP_PHASES[i].id,
      startMs: boundaries[i],
      endMs: boundaries[i + 1],
    })
  }
  return phases
}

export const SCANNER_SEQUENCE_DESKTOP: ScannerSequencePhase[] =
  buildPhases(DESKTOP_PHASE_BOUNDARIES_MS)

export const SCANNER_SEQUENCE_MOBILE: ScannerSequencePhase[] = buildPhases(
  MOBILE_PHASE_BOUNDARIES_MS
)

export function createScannerSequenceTimeline(
  profileId: ScannerKeywordProfileId,
  options?: { isMobile?: boolean }
): ScannerSequenceTimeline {
  const isMobile = options?.isMobile ?? false
  return {
    totalDurationMs: isMobile ? MOBILE_SCANNER_DURATION_MS : SCANNER_DURATION_MS,
    phases: isMobile ? SCANNER_SEQUENCE_MOBILE : SCANNER_SEQUENCE_DESKTOP,
    profileId,
  }
}

export function getScannerPhaseAt(
  timeline: ScannerSequenceTimeline,
  elapsedMs: number
): ScannerSequencePhase {
  const t = Math.max(0, Math.min(elapsedMs, timeline.totalDurationMs))
  const phase =
    timeline.phases.find((p) => t >= p.startMs && t < p.endMs) ??
    timeline.phases[timeline.phases.length - 1]
  return phase
}

/** Progress 0–1 through full scanner experience. */
export function getScannerProgress(
  timeline: ScannerSequenceTimeline,
  elapsedMs: number
): number {
  if (timeline.totalDurationMs <= 0) return 1
  return Math.min(1, Math.max(0, elapsedMs / timeline.totalDurationMs))
}

/**
 * Typing progress 0–1 within typing phase (for character reveal).
 */
export function getScannerTypingProgress(
  timeline: ScannerSequenceTimeline,
  elapsedMs: number
): number {
  const typing = timeline.phases.find((p) => p.id === 'typing')
  if (!typing) return 0
  if (elapsedMs <= typing.startMs) return 0
  if (elapsedMs >= typing.endMs) return 1
  return (elapsedMs - typing.startMs) / (typing.endMs - typing.startMs)
}
