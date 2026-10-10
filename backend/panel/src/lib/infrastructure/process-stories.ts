import type { MarketplaceId } from './types'

export type ProcessStep = {
  id: string
  label: string
  description: string
  status: string
}

export type MarketplaceProcessConfig = {
  id: MarketplaceId
  label: string
  caption: string
  steps: ProcessStep[]
}

export const HERO_MARKETPLACES = ['eBay', 'Pinterest'] as const

export const HERO_LAYER_LABEL = 'ListJetGo intelligence layer'

export const HERO_EXECUTION_STEPS = [
  { label: 'Research', description: 'Find and score opportunities' },
  { label: 'Listing', description: 'Prepare listings and content' },
  { label: 'Dispatch', description: 'Route work across stores' },
  { label: 'Monitor', description: 'Track live inventory and status' },
] as const

export const MARKETPLACE_PROCESSES: MarketplaceProcessConfig[] = [
  {
    id: 'ebay',
    label: 'eBay',
    caption:
      'eBay operations: research products, prepare listings, dispatch across stores, and monitor live inventory.',
    steps: [
      {
        id: 'research',
        label: 'Research',
        description: 'Scan niches and validate demand before listing.',
        status: 'Opportunity scoring',
      },
      {
        id: 'pool',
        label: 'Pool',
        description: 'Queue validated products for the next operational stage.',
        status: 'Ready queue',
      },
      {
        id: 'ai',
        label: 'AI Content',
        description: 'Generate titles, attributes, and listing copy.',
        status: 'Content generated',
      },
      {
        id: 'dispatch',
        label: 'Dispatch',
        description: 'Send prepared listings to the right stores.',
        status: 'Routing active',
      },
      {
        id: 'listed',
        label: 'Listed',
        description: 'Live listings across connected eBay stores.',
        status: 'Published',
      },
      {
        id: 'monitor',
        label: 'Monitor',
        description: 'Watch inventory, pricing, and listing health.',
        status: 'Live monitoring',
      },
    ],
  },
  {
    id: 'pinterest',
    label: 'Pinterest',
    caption:
      'Pinterest distribution: turn marketplace listings into scheduled discovery content.',
    steps: [
      {
        id: 'listing',
        label: 'Listing',
        description: 'Start from a product listing ready to promote.',
        status: 'Source ready',
      },
      {
        id: 'queue',
        label: 'Pin Queue',
        description: 'Queue pins for boards and campaigns.',
        status: 'Queued',
      },
      {
        id: 'route',
        label: 'Board Route',
        description: 'Route content to the right boards and audiences.',
        status: 'Routing',
      },
      {
        id: 'scheduled',
        label: 'Scheduled Pin',
        description: 'Schedule pins for consistent discovery.',
        status: 'Scheduled',
      },
      {
        id: 'traffic',
        label: 'Traffic Loop',
        description: 'Measure clicks and feed the next listing cycle.',
        status: 'Tracking',
      },
    ],
  },
]

export function getMarketplaceProcess(id: MarketplaceId): MarketplaceProcessConfig {
  return MARKETPLACE_PROCESSES.find((m) => m.id === id) ?? MARKETPLACE_PROCESSES[0]
}
