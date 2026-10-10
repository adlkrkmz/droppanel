'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  GRID_PULSE_OPACITY_MAX,
  advanceMarketPulseGrid,
  cellPulseOpacity,
  createMarketPulseGrid,
  createTimerRegistry,
  prefersReducedMotion,
} from '@/lib/simulation'

export default function MarketPulseGrid() {
  const [snapshot, setSnapshot] = useState(() => createMarketPulseGrid(42))
  const [tick, setTick] = useState(0)

  const gridStyle = useMemo(
    () =>
      ({
        gridTemplateColumns: `repeat(${snapshot.cols}, 1fr)`,
        gridTemplateRows: `repeat(${snapshot.rows}, 1fr)`,
        ['--lj-grid-pulse-max']: String(GRID_PULSE_OPACITY_MAX),
      }) as React.CSSProperties,
    [snapshot.cols, snapshot.rows]
  )

  useEffect(() => {
    if (prefersReducedMotion()) return
    const registry = createTimerRegistry()
    registry.setInterval(() => {
      setTick((t) => {
        const next = t + 1
        setSnapshot((prev) => advanceMarketPulseGrid(prev, next))
        return next
      })
    }, 2400)
    return () => registry.clearAll()
  }, [])

  return (
    <div
      className="lj-pulse-layer"
      aria-hidden
      style={{ ['--lj-grid-pulse-max' as string]: GRID_PULSE_OPACITY_MAX }}
    >
      <div className="lj-pulse-grid" style={gridStyle}>
        {snapshot.cells.map((cell) => {
          const opacity = cellPulseOpacity(cell)
          const scale = cell.active ? opacity / GRID_PULSE_OPACITY_MAX : 0
          return (
            <div
              key={`${cell.row}-${cell.col}-${tick}`}
              className={
                cell.active ? 'lj-pulse-cell lj-pulse-cell--active' : 'lj-pulse-cell'
              }
              style={{
                opacity: scale * GRID_PULSE_OPACITY_MAX,
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
