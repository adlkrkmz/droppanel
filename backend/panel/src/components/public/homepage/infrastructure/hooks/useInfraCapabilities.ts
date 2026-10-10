'use client'

import { useEffect, useState } from 'react'

import { MOBILE_BREAKPOINT_PX } from '@/lib/infrastructure/constants'
import { prefersReducedMotion } from '@/lib/simulation'

export function useInfraCapabilities(): {
  isMobile: boolean
  motionEnabled: boolean
} {
  const [isMobile, setIsMobile] = useState(false)
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`)
    const mqMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

    const apply = () => {
      setIsMobile(mq.matches)
      setReduced(mqMotion.matches)
    }
    apply()
    mq.addEventListener('change', apply)
    mqMotion.addEventListener('change', apply)
    return () => {
      mq.removeEventListener('change', apply)
      mqMotion.removeEventListener('change', apply)
    }
  }, [])

  return {
    isMobile,
    motionEnabled: !isMobile && !reduced && !prefersReducedMotion(),
  }
}
