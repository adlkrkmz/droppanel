'use client'

import { useCallback, useEffect, useState } from 'react'

import { prefersReducedMotion } from '@/lib/simulation'

type SurfaceRevealOptions = {
  threshold?: number
  rootMargin?: string
}

export function useSurfaceReveal(options?: SurfaceRevealOptions): {
  setRef: (node: HTMLElement | null) => void
  revealed: boolean
} {
  const { threshold = 0.15, rootMargin = '0px 0px -8% 0px' } = options ?? {}
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [revealed, setRevealed] = useState(false)

  const setRef = useCallback((node: HTMLElement | null) => {
    setElement(node)
  }, [])

  useEffect(() => {
    if (prefersReducedMotion()) {
      setRevealed(true)
      return
    }

    if (!element) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setRevealed(true)
          observer.disconnect()
        }
      },
      { threshold, rootMargin }
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [element, threshold, rootMargin])

  return { setRef, revealed }
}
