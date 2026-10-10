'use client'

import type { FlowVariant } from '@/lib/infrastructure/types'
import type { InfraNode } from '@/lib/infrastructure/types'

type MarketplaceNodeFieldProps = {
  nodes: InfraNode[]
  variant?: FlowVariant | 'hero' | 'mode'
  motionEnabled: boolean
}

export default function MarketplaceNodeField({
  nodes,
  variant = 'hero',
  motionEnabled,
}: MarketplaceNodeFieldProps) {
  const chaos = variant === 'chaos'

  return (
    <div className="ops-infra-nodes" aria-hidden>
      {nodes.map((node, i) => (
        <div
          key={node.id}
          className={`ops-infra-node${chaos ? ' ops-infra-node--chaos' : ''}${
            node.id === 'hub' ? ' ops-infra-node--hub' : ''
          }${motionEnabled ? ' ops-infra-node--pulse' : ''}`}
          style={{
            left: `${node.x}%`,
            top: `${node.y}%`,
            animationDelay: motionEnabled ? `${(i * 0.7) % 4}s` : undefined,
          }}
        >
          <span className="ops-infra-node-dot" />
          <span className="ops-infra-node-label">{node.label}</span>
        </div>
      ))}
    </div>
  )
}
