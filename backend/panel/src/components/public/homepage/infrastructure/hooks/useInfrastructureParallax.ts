'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { INFRA_PARALLAX_MAX_PX } from '@/lib/infrastructure/constants'

export function useInfrastructureParallax(enabled: boolean): {
  setLayerRef: (node: HTMLDivElement | null) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerLeave: () => void
  transform: string
} {
  const layerEl = useRef<HTMLDivElement | null>(null)
  const [transform, setTransform] = useState('translate3d(0,0,0)')
  const rafRef = useRef<number | null>(null)

  const setLayerRef = useCallback((node: HTMLDivElement | null) => {
    layerEl.current = node
  }, [])

  const onPointerLeave = useCallback(() => {
    if (!enabled) return
    setTransform('translate3d(0,0,0)')
  }, [enabled])

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled || !layerEl.current) return
      const rect = layerEl.current.parentElement?.getBoundingClientRect()
      if (!rect) return

      const nx = (e.clientX - rect.left) / rect.width - 0.5
      const ny = (e.clientY - rect.top) / rect.height - 0.5
      const tx = Math.max(
        -INFRA_PARALLAX_MAX_PX,
        Math.min(INFRA_PARALLAX_MAX_PX, nx * INFRA_PARALLAX_MAX_PX * 2)
      )
      const ty = Math.max(
        -INFRA_PARALLAX_MAX_PX,
        Math.min(INFRA_PARALLAX_MAX_PX, ny * INFRA_PARALLAX_MAX_PX * 2)
      )

      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        setTransform(`translate3d(${tx.toFixed(2)}px,${ty.toFixed(2)}px,0)`)
      })
    },
    [enabled]
  )

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    },
    []
  )

  return { setLayerRef, onPointerMove, onPointerLeave, transform }
}
