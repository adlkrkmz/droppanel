import type { InfraNode, InfraRoute } from '@/lib/infrastructure/types'

export function nodeById(nodes: InfraNode[], id: string): InfraNode | undefined {
  return nodes.find((n) => n.id === id)
}

export function routePath(
  from: InfraNode,
  to: InfraNode,
  deadEnd?: boolean
): string {
  if (deadEnd) {
    const mx = (from.x + to.x) / 2
    const my = (from.y + to.y) / 2
    return `M ${from.x} ${from.y} L ${mx} ${my}`
  }
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`
}

export function routeMidpoint(
  from: InfraNode,
  to: InfraNode,
  deadEnd?: boolean
): { x: number; y: number } {
  if (deadEnd) {
    return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
  }
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
}
