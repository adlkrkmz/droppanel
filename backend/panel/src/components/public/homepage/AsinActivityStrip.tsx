'use client'

import { useMemo } from 'react'
import { SIMULATION_DISCLAIMER, createAsinActivityStrip, signalColorToken } from '@/lib/simulation'

export default function AsinActivityStrip() {
  const data = useMemo(() => createAsinActivityStrip(), [])
  const duplicated = useMemo(() => [...data.items, ...data.items], [data.items])

  return (
    <section className="lj-asin-section" aria-label="ASIN activity preview">
      <p className="lj-asin-label">{SIMULATION_DISCLAIMER}</p>
      <div className="lj-asin-track-wrap">
        <div className="lj-asin-track">
          {duplicated.map((item, i) => (
            <div key={`${item.asin}-${i}`} className="lj-asin-item">
              <span
                className="lj-asin-signal"
                style={{ background: signalColorToken(item.signal) }}
              />
              <span className="lj-asin-asin">{item.asin}</span>
              <span>{item.title}</span>
              <span style={{ color: 'var(--lj-dim)' }}>{item.velocityLabel}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
