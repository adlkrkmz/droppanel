/**
 * Phase S — Simulation Engine (homepage foundation).
 * Simulated demo data only. No API / backend / production state.
 */

export {
  SCANNER_DURATION_MS,
  MOBILE_SCANNER_DURATION_MS,
  GRID_PULSE_OPACITY_MAX,
  GRID_MAX_ACTIVE_CELLS,
  MARKET_PULSE_GRID_COLS,
  MARKET_PULSE_GRID_ROWS,
  ASIN_STRIP_VISIBLE_COUNT,
  TICKER_DEFAULT_STEP_MS,
} from './constants'

export {
  DEMO_MODE_LABEL,
  DEMO_MODE_HINT,
  SIMULATION_DISCLAIMER,
  SCANNER_PLACEHOLDER,
  SCANNER_STATUS_LABELS,
} from './demo-copy'

export {
  prefersReducedMotion,
  getScannerDurationMs,
  resolveMotionTimelineMs,
} from './reduced-motion'

export {
  createTimeout,
  createInterval,
  clearTimeoutSafe,
  clearIntervalSafe,
  createTimerRegistry,
} from './timers'
export type { TimeoutHandle, IntervalHandle } from './timers'

export { runTickerCounter } from './ticker-counter'
export type { TickerCounterOptions } from './ticker-counter'

export {
  createMarketPulseGrid,
  advanceMarketPulseGrid,
  cellPulseOpacity,
} from './market-pulse-grid'
export type { MarketPulseCell, MarketPulseGridSnapshot } from './market-pulse-grid'

export {
  createAsinActivityStrip,
  rotateAsinStrip,
  signalColorToken,
} from './asin-activity-strip'
export type {
  AsinStripItem,
  AsinStripSignal,
  AsinActivityStripData,
} from './asin-activity-strip'

export {
  createNicheCardDeck,
  getNicheCardById,
} from './niche-cards'
export type { NicheCardData, NicheCardDeck, NicheCardTrend } from './niche-cards'

export {
  SCANNER_KEYWORD_PROFILES,
  DEFAULT_SCANNER_PROFILE_ID,
  getScannerKeywordProfile,
  listScannerKeywordProfileIds,
} from './scanner-keyword-profiles'
export type {
  ScannerKeywordProfile,
  ScannerKeywordProfileId,
} from './scanner-keyword-profiles'

export {
  SCANNER_SEQUENCE_DESKTOP,
  SCANNER_SEQUENCE_MOBILE,
  createScannerSequenceTimeline,
  getScannerPhaseAt,
  getScannerProgress,
  getScannerTypingProgress,
} from './scanner-sequence'
export type {
  ScannerSequencePhase,
  ScannerSequencePhaseId,
  ScannerSequenceTimeline,
} from './scanner-sequence'

export {
  SCANNER_STAGED_LINES,
  deriveScannerDemoResults,
} from './scanner-ui'
export type { ScannerDemoResults } from './scanner-ui'
