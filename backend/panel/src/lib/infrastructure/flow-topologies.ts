import type { InfraTopology } from './types'

/** Without ListJetGo — fragmented, delayed, dead-end flows. */
export const CHAOS_TOPOLOGY: InfraTopology = {
  nodes: [
    { id: 'ebay', label: 'eBay', x: 18, y: 28, marketplace: 'ebay' },
    { id: 'pin', label: 'Pinterest', x: 78, y: 68, marketplace: 'pinterest' },
    { id: 'amz', label: 'Amazon', x: 22, y: 72, marketplace: 'amazon' },
    { id: 'sheet', label: 'SHEET', x: 48, y: 48 },
  ],
  routes: [
    { id: 'c1', from: 'ebay', to: 'sheet', signal: true, deadEnd: true },
    { id: 'c3', from: 'amz', to: 'ebay', deadEnd: true },
    { id: 'c4', from: 'sheet', to: 'pin', signal: true, deadEnd: true },
  ],
}

/** With ListJetGo — hub orchestration, synchronized mesh. */
export const ORCHESTRATED_TOPOLOGY: InfraTopology = {
  nodes: [
    { id: 'hub', label: 'LAYER', x: 50, y: 50 },
    { id: 'ebay', label: 'eBay', x: 22, y: 32, marketplace: 'ebay' },
    { id: 'pin', label: 'Pinterest', x: 74, y: 72, marketplace: 'pinterest' },
    { id: 'amz', label: 'Amazon', x: 24, y: 70, marketplace: 'amazon' },
  ],
  routes: [
    { id: 'o1', from: 'hub', to: 'ebay', signal: true },
    { id: 'o3', from: 'hub', to: 'pin', signal: true },
    { id: 'o4', from: 'hub', to: 'amz', signal: true },
  ],
}

/** Hero ambient network — four marketplaces + soft interlinks. */
export const HERO_TOPOLOGY: InfraTopology = {
  nodes: [
    { id: 'ebay', label: 'eBay', x: 24, y: 38, marketplace: 'ebay' },
    { id: 'pin', label: 'Pinterest', x: 68, y: 34, marketplace: 'pinterest' },
    { id: 'amz', label: 'Amazon', x: 58, y: 72, marketplace: 'amazon' },
  ],
  routes: [
    { id: 'h3', from: 'pin', to: 'amz', signal: true },
    { id: 'h4', from: 'amz', to: 'ebay', signal: true },
    { id: 'h5', from: 'ebay', to: 'pin', signal: true },
  ],
}

/** Lite hero — mobile: fewer nodes */
export const HERO_TOPOLOGY_LITE: InfraTopology = {
  nodes: [
    { id: 'ebay', label: 'eBay', x: 28, y: 42, marketplace: 'ebay' },
    { id: 'pin', label: 'Pinterest', x: 72, y: 40, marketplace: 'pinterest' },
  ],
  routes: [
  ],
}
