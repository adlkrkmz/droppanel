'use client'

import { HERO_TOPOLOGY, HERO_TOPOLOGY_LITE } from '@/lib/infrastructure/flow-topologies'

import InfrastructureCanvas from './InfrastructureCanvas'
import { useInfraCapabilities } from './hooks/useInfraCapabilities'
import { useInfrastructureParallax } from './hooks/useInfrastructureParallax'
import MarketplaceNodeField from './MarketplaceNodeField'
import SignalRouteLayer from './SignalRouteLayer'

export default function HeroInfrastructureLayer() {
  const { isMobile, motionEnabled } = useInfraCapabilities()
  const { setLayerRef, onPointerMove, onPointerLeave, transform } =
    useInfrastructureParallax(motionEnabled)

  const topology = isMobile ? HERO_TOPOLOGY_LITE : HERO_TOPOLOGY
  const lite = isMobile

  return (
    <div
      className="ops-hero-planes ops-hero-planes--infra"
      ref={setLayerRef}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      aria-hidden
    >
      <div className="ops-hero-plane ops-hero-plane--1" />
      <div className="ops-hero-plane ops-hero-plane--2" />
      <div className="ops-hero-plane ops-hero-plane--lines" />
      <InfrastructureCanvas transform={transform} lite={lite} className="ops-hero-infra">
        <SignalRouteLayer
          topology={topology}
          variant="hero"
          motionEnabled={motionEnabled}
        />
        <MarketplaceNodeField
          nodes={topology.nodes}
          variant="hero"
          motionEnabled={motionEnabled}
        />
      </InfrastructureCanvas>
    </div>
  )
}
