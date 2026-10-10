'use client'

import {
  CHAOS_TOPOLOGY,
  ORCHESTRATED_TOPOLOGY,
} from '@/lib/infrastructure/flow-topologies'
import type { FlowVariant } from '@/lib/infrastructure/types'

import InfrastructureCanvas from './InfrastructureCanvas'
import { useInfraCapabilities } from './hooks/useInfraCapabilities'
import MarketplaceNodeField from './MarketplaceNodeField'
import SignalRouteLayer from './SignalRouteLayer'

type OperationalFlowSimProps = {
  variant: FlowVariant
}

export default function OperationalFlowSim({ variant }: OperationalFlowSimProps) {
  const { motionEnabled } = useInfraCapabilities()
  const topology = variant === 'chaos' ? CHAOS_TOPOLOGY : ORCHESTRATED_TOPOLOGY
  const chaos = variant === 'chaos'

  return (
    <div
      className={`ops-flow-sim${chaos ? ' ops-flow-sim--chaos' : ' ops-flow-sim--orchestrated'}`}
      aria-hidden
    >
      <InfrastructureCanvas className="ops-flow-sim-canvas">
        <SignalRouteLayer
          topology={topology}
          variant={variant}
          motionEnabled={motionEnabled}
        />
        <MarketplaceNodeField
          nodes={topology.nodes}
          variant={variant}
          motionEnabled={motionEnabled}
        />
      </InfrastructureCanvas>
    </div>
  )
}
