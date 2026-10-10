'use client'

import { useMemo } from 'react'

import { randomSignalTravelSec } from '@/lib/infrastructure/route-pulse-engine'
import type { FlowVariant } from '@/lib/infrastructure/types'
import type { InfraRoute, InfraTopology } from '@/lib/infrastructure/types'

import { useRouteSignals } from './hooks/useRouteSignals'
import { nodeById, routeMidpoint, routePath } from './utils'

type SignalRouteLayerProps = {
  topology: InfraTopology
  variant?: FlowVariant | 'hero' | 'mode'
  motionEnabled: boolean
  className?: string
}

export default function SignalRouteLayer({
  topology,
  variant = 'hero',
  motionEnabled,
  className = '',
}: SignalRouteLayerProps) {
  const activeIds = useRouteSignals(topology.routes, motionEnabled)

  return (
    <svg
      className={`ops-infra-svg ops-infra-routes ${className}`}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      {topology.routes.map((route) => (
        <RouteLine
          key={route.id}
          route={route}
          topology={topology}
          variant={variant}
          isActive={activeIds.includes(route.id)}
          motionEnabled={motionEnabled}
        />
      ))}
    </svg>
  )
}

function RouteLine({
  route,
  topology,
  variant,
  isActive,
  motionEnabled,
}: {
  route: InfraRoute
  topology: InfraTopology
  variant: FlowVariant | 'hero' | 'mode'
  isActive: boolean
  motionEnabled: boolean
}) {
  const from = nodeById(topology.nodes, route.from)
  const to = nodeById(topology.nodes, route.to)
  const travelSec = useMemo(() => randomSignalTravelSec(), [route.id, isActive])

  if (!from || !to) return null

  const d = routePath(from, to, route.deadEnd)
  const chaos = variant === 'chaos'
  const mid = routeMidpoint(from, to, route.deadEnd)
  const showMotion = isActive && motionEnabled
  const showStaticSignal = isActive && !motionEnabled

  return (
    <g className={`ops-infra-route-group${chaos ? ' ops-infra-route-group--chaos' : ''}`}>
      <path
        d={d}
        className={`ops-infra-route${route.deadEnd ? ' ops-infra-route--dead' : ''}${
          isActive ? ' ops-infra-route--signal' : ''
        }`}
        vectorEffect="non-scaling-stroke"
      />
      {showMotion ? (
        <>
          <path
            d={d}
            pathLength={100}
            className="ops-infra-route-travel"
            vectorEffect="non-scaling-stroke"
            style={{ animationDuration: `${travelSec}s` }}
          />
          <circle className="ops-infra-signal-dot" r="1.15">
            <animateMotion
              dur={`${travelSec}s`}
              repeatCount="indefinite"
              path={d}
              calcMode="linear"
            />
          </circle>
        </>
      ) : null}
      {showStaticSignal ? (
        <circle
          className="ops-infra-signal-dot ops-infra-signal-dot--static"
          r="1.2"
          cx={mid.x}
          cy={mid.y}
        />
      ) : null}
    </g>
  )
}
