'use client'

import type { ReactNode } from 'react'

type InfrastructureCanvasProps = {
  children: ReactNode
  className?: string
  transform?: string
  lite?: boolean
}

export default function InfrastructureCanvas({
  children,
  className = '',
  transform = 'translate3d(0,0,0)',
  lite = false,
}: InfrastructureCanvasProps) {
  return (
    <div
      className={`ops-infra-canvas${lite ? ' ops-infra-canvas--lite' : ''}${className ? ` ${className}` : ''}`}
      style={{ transform }}
    >
      {children}
    </div>
  )
}
