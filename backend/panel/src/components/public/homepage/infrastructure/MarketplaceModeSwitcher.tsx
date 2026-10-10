'use client'

import { useState } from 'react'

import { MODE_TRANSITION_MS } from '@/lib/infrastructure/constants'
import {
  MARKETPLACE_PROCESSES,
  getMarketplaceProcess,
} from '@/lib/infrastructure/process-stories'
import type { MarketplaceId } from '@/lib/infrastructure/types'

import ProcessPipeline from './ProcessPipeline'
import ProcessStepCards from './ProcessStepCards'
import SurfaceReveal from '../SurfaceReveal'

export default function MarketplaceModeSwitcher() {
  const [active, setActive] = useState<MarketplaceId>('ebay')
  const mode = getMarketplaceProcess(active)

  return (
    <SurfaceReveal className="ops-mode-section" id="platform-modes">
      <div className="ops-mode-inner">
        <header className="ops-mode-header">
          <p className="ops-compare-eyebrow">Marketplace operations</p>
          <h2 className="ops-compare-title">One layer. Three marketplace workflows.</h2>
          <p className="ops-compare-intro">
            Each marketplace uses the same ListJetGo layer, but the operational steps change
            to match how you sell there.
          </p>
        </header>

        <div
          className="ops-mode-tabs"
          role="tablist"
          aria-label="Marketplace workflow"
        >
          {MARKETPLACE_PROCESSES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={active === m.id}
              className={`ops-mode-tab${active === m.id ? ' ops-mode-tab--active' : ''}`}
              onClick={() => setActive(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="ops-mode-panel" role="tabpanel">
          {MARKETPLACE_PROCESSES.map((m) => (
            <div
              key={m.id}
              className={`ops-mode-panel-layer${active === m.id ? ' ops-mode-panel-layer--active' : ''}`}
              style={{ transitionDuration: `${MODE_TRANSITION_MS}ms` }}
              aria-hidden={active !== m.id}
            >
              <p className="ops-mode-caption">{m.caption}</p>
              <div className="ops-mode-viz-wrap">
                <ProcessPipeline steps={m.steps} active={active === m.id} />
                <ProcessStepCards steps={m.steps} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </SurfaceReveal>
  )
}
