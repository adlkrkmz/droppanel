/**
 * Phase S — simulation timing & visual ceilings (homepage foundation).
 * All values are demo/simulated; not production telemetry.
 */

/** Desktop interactive scanner total duration — do not shorten. */
export const SCANNER_DURATION_MS = 3500

/** Mobile scanner duration (slightly shorter viewport UX). */
export const MOBILE_SCANNER_DURATION_MS = 2800

/** Maximum opacity for ambient market-pulse grid cells (CSS should reference this). */
export const GRID_PULSE_OPACITY_MAX = 0.18

/** Maximum simultaneously “active” cells in the pulse grid. */
export const GRID_MAX_ACTIVE_CELLS = 6

export const MARKET_PULSE_GRID_COLS = 16
export const MARKET_PULSE_GRID_ROWS = 9

/** ASIN strip visible slot count (marquee window). */
export const ASIN_STRIP_VISIBLE_COUNT = 8

/** Ticker default step interval when motion is allowed (ms). */
export const TICKER_DEFAULT_STEP_MS = 48
