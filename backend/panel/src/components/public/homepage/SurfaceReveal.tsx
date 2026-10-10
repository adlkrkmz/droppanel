'use client'

import type { ReactNode } from 'react'

import { useSurfaceReveal } from './useSurfaceReveal'

type SurfaceRevealProps = {
  children: ReactNode
  className?: string
  id?: string
}

export default function SurfaceReveal({
  children,
  className = '',
  id,
}: SurfaceRevealProps) {
  const { setRef, revealed } = useSurfaceReveal()

  return (
    <section
      id={id}
      ref={setRef}
      className={`ops-reveal${revealed ? ' ops-reveal--visible' : ''}${className ? ` ${className}` : ''}`}
    >
      {children}
    </section>
  )
}
