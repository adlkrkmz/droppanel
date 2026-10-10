import type { MarketplaceId, MarketplaceModeConfig } from './types'

export const MARKETPLACE_MODES: MarketplaceModeConfig[] = [
  {
    id: 'ebay',
    label: 'eBay',
    rhythmClass: 'ops-mode--ebay',
    statusSegments: [
      'READY POOL',
      'AI SCORE ACTIVE',
      'DISPATCH QUEUE STABLE',
    ],
    nodes: [
      { id: 'e1', label: 'POOL', x: 22, y: 48 },
      { id: 'e2', label: 'AI SCORE', x: 42, y: 28 },
      { id: 'e3', label: 'DISPATCH', x: 58, y: 52 },
      { id: 'e4', label: 'LISTED', x: 76, y: 40 },
      { id: 'e5', label: 'MONITOR', x: 36, y: 72 },
    ],
    routes: [
      { id: 'er1', from: 'e1', to: 'e2', signal: true },
      { id: 'er2', from: 'e2', to: 'e3', signal: true },
      { id: 'er3', from: 'e3', to: 'e4', signal: true },
      { id: 'er4', from: 'e4', to: 'e5', signal: true },
      { id: 'er5', from: 'e1', to: 'e3', signal: true },
      { id: 'er6', from: 'e5', to: 'e1', signal: true },
    ],
  },
  {
    id: 'pinterest',
    label: 'Pinterest',
    rhythmClass: 'ops-mode--pinterest',
    statusSegments: [
      'PIN QUEUE READY',
      'BOARD ROUTING',
      'TRAFFIC LOOP',
    ],
    nodes: [
      { id: 'p1', label: 'SOURCE', x: 50, y: 62 },
      { id: 'p2', label: 'PIN QUEUE', x: 28, y: 44 },
      { id: 'p3', label: 'BOARD ROUTE', x: 72, y: 44 },
      { id: 'p4', label: 'DISTRIBUTE', x: 50, y: 30 },
      { id: 'p5', label: 'TRAFFIC LOOP', x: 50, y: 16 },
    ],
    routes: [
      { id: 'pr1', from: 'p1', to: 'p2', signal: true },
      { id: 'pr2', from: 'p1', to: 'p3', signal: true },
      { id: 'pr3', from: 'p2', to: 'p4', signal: true },
      { id: 'pr4', from: 'p3', to: 'p4', signal: true },
      { id: 'pr5', from: 'p4', to: 'p5', signal: true },
    ],
  },
]

export function getMarketplaceMode(id: MarketplaceId): MarketplaceModeConfig {
  return MARKETPLACE_MODES.find((m) => m.id === id) ?? MARKETPLACE_MODES[0]
}
