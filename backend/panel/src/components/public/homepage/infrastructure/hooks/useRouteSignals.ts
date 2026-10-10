'use client'

import { useEffect, useMemo, useState } from 'react'

import {
  pickActiveSignalIds,
  randomHeartbeatMs,
} from '@/lib/infrastructure/route-pulse-engine'
import type { InfraRoute } from '@/lib/infrastructure/types'

export function useRouteSignals(
  routes: InfraRoute[],
  enabled: boolean
): string[] {
  const signalRouteIds = useMemo(
    () => routes.filter((r) => r.signal).map((r) => r.id),
    [routes]
  )

  const [activeIds, setActiveIds] = useState<string[]>(() =>
    signalRouteIds.slice(0, 1)
  )

  useEffect(() => {
    if (signalRouteIds.length === 0) {
      setActiveIds([])
      return
    }

    if (!enabled) {
      setActiveIds(signalRouteIds.slice(0, Math.min(2, signalRouteIds.length)))
      return
    }

    let timeout: ReturnType<typeof setTimeout>

    const tick = () => {
      setActiveIds(pickActiveSignalIds(signalRouteIds))
      timeout = setTimeout(tick, randomHeartbeatMs())
    }

    setActiveIds(pickActiveSignalIds(signalRouteIds))
    timeout = setTimeout(tick, randomHeartbeatMs())

    return () => clearTimeout(timeout)
  }, [enabled, signalRouteIds])

  return activeIds
}
