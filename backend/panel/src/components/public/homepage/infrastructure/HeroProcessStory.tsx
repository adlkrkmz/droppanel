'use client'

import type { CSSProperties } from 'react'

import {
  HERO_EXECUTION_STEPS,
  HERO_LAYER_LABEL,
  HERO_MARKETPLACES,
} from '@/lib/infrastructure/process-stories'

import { useInfraCapabilities } from './hooks/useInfraCapabilities'

export default function HeroProcessStory() {
  const { motionEnabled } = useInfraCapabilities()

  return (
    <div
      className={`ops-hero-flow${motionEnabled ? ' ops-hero-flow--motion' : ''}`}
      aria-label="How ListJetGo connects marketplaces to execution"
    >
      <div className="ops-hero-flow-tier ops-hero-flow-tier--markets">
        <p className="ops-hero-flow-tier-label">Marketplaces</p>
        <div className="ops-hero-flow-chips">
          {HERO_MARKETPLACES.map((name) => (
            <span key={name} className="ops-hero-flow-chip">
              {name}
            </span>
          ))}
        </div>
      </div>

      <div className="ops-hero-flow-connector" aria-hidden>
        <span className="ops-hero-flow-arrow">↓</span>
      </div>

      <div className="ops-hero-flow-tier ops-hero-flow-tier--layer">
        <p className="ops-hero-flow-tier-label">Operations layer</p>
        <p className="ops-hero-flow-layer-name">{HERO_LAYER_LABEL}</p>
      </div>

      <div className="ops-hero-flow-connector" aria-hidden>
        <span className="ops-hero-flow-arrow">↓</span>
      </div>

      <div className="ops-hero-flow-tier ops-hero-flow-tier--execution">
        <p className="ops-hero-flow-tier-label">Execution</p>
        <ol className="ops-hero-flow-steps">
          {HERO_EXECUTION_STEPS.map((step, i) => (
            <li
              key={step.label}
              className="ops-hero-flow-step"
              style={
                motionEnabled
                  ? ({ ['--ops-step-i' as string]: i } as CSSProperties)
                  : undefined
              }
            >
              <span className="ops-hero-flow-step-name">{step.label}</span>
              <span className="ops-hero-flow-step-desc">{step.description}</span>
              {i < HERO_EXECUTION_STEPS.length - 1 ? (
                <span className="ops-hero-flow-step-arrow" aria-hidden>
                  →
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
