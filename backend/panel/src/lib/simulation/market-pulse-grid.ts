import {
  GRID_MAX_ACTIVE_CELLS,
  GRID_PULSE_OPACITY_MAX,
  MARKET_PULSE_GRID_COLS,
  MARKET_PULSE_GRID_ROWS,
} from './constants'

export type MarketPulseCell = {
  row: number
  col: number
  /** 0–1 intensity; clamped to GRID_PULSE_OPACITY_MAX at render time. */
  intensity: number
  active: boolean
}

export type MarketPulseGridSnapshot = {
  cols: number
  rows: number
  cells: MarketPulseCell[]
  activeCount: number
  generatedAt: number
}

function clampIntensity(value: number): number {
  return Math.min(GRID_PULSE_OPACITY_MAX, Math.max(0, value))
}

function mulberry32(seed: number) {
  return function next() {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildCells(seed: number): MarketPulseCell[] {
  const rand = mulberry32(seed)
  const total = MARKET_PULSE_GRID_COLS * MARKET_PULSE_GRID_ROWS
  const indices = Array.from({ length: total }, (_, i) => i)

  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }

  const activeSet = new Set(
    indices.slice(0, GRID_MAX_ACTIVE_CELLS).map((idx) => idx)
  )

  const cells: MarketPulseCell[] = []
  for (let row = 0; row < MARKET_PULSE_GRID_ROWS; row++) {
    for (let col = 0; col < MARKET_PULSE_GRID_COLS; col++) {
      const idx = row * MARKET_PULSE_GRID_COLS + col
      const active = activeSet.has(idx)
      const intensity = active
        ? clampIntensity(0.06 + rand() * (GRID_PULSE_OPACITY_MAX - 0.06))
        : 0
      cells.push({ row, col, intensity, active })
    }
  }
  return cells
}

/** Initial deterministic grid for demo ambient pulse. */
export function createMarketPulseGrid(seed = 42): MarketPulseGridSnapshot {
  const cells = buildCells(seed)
  return {
    cols: MARKET_PULSE_GRID_COLS,
    rows: MARKET_PULSE_GRID_ROWS,
    cells,
    activeCount: cells.filter((c) => c.active).length,
    generatedAt: Date.now(),
  }
}

/**
 * Advance pulse pattern — rotates which cells are active (still ≤ GRID_MAX_ACTIVE_CELLS).
 */
export function advanceMarketPulseGrid(
  previous: MarketPulseGridSnapshot,
  tick: number
): MarketPulseGridSnapshot {
  const seed = 42 + tick * 17
  const cells = buildCells(seed)
  return {
    cols: previous.cols,
    rows: previous.rows,
    cells,
    activeCount: cells.filter((c) => c.active).length,
    generatedAt: Date.now(),
  }
}

/** CSS opacity for a cell — never exceeds GRID_PULSE_OPACITY_MAX. */
export function cellPulseOpacity(cell: MarketPulseCell): number {
  if (!cell.active) return 0
  return clampIntensity(cell.intensity)
}
