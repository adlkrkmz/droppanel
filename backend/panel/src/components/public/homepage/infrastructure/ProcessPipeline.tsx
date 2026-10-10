'use client'

import type { CSSProperties } from 'react'

import type { ProcessStep } from '@/lib/infrastructure/process-stories'

import { useInfraCapabilities } from './hooks/useInfraCapabilities'

type ProcessPipelineProps = {
  steps: ProcessStep[]
  active?: boolean
}

export default function ProcessPipeline({ steps, active = true }: ProcessPipelineProps) {
  const { motionEnabled } = useInfraCapabilities()
  const animate = motionEnabled && active

  return (
    <div
      className={`ops-process-pipeline${animate ? ' ops-process-pipeline--motion' : ''}`}
      role="list"
      aria-label="Operational process flow"
    >
      {steps.map((step, i) => (
        <div key={step.id} className="ops-process-pipeline-item" role="listitem">
          <div
            className="ops-process-pipeline-node"
            style={
              animate ? ({ ['--ops-pipe-i' as string]: i } as CSSProperties) : undefined
            }
          >
            <span className="ops-process-pipeline-label">{step.label}</span>
          </div>
          {i < steps.length - 1 ? (
            <span className="ops-process-pipeline-arrow" aria-hidden>
              →
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}
