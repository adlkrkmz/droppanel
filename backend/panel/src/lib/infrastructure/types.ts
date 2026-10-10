export type MarketplaceId = 'ebay' | 'pinterest' | 'amazon'

export type FlowVariant = 'chaos' | 'orchestrated'

export type InfraNode = {
  id: string
  label: string
  x: number
  y: number
  marketplace?: MarketplaceId
}

export type InfraRoute = {
  id: string
  from: string
  to: string
  /** Dead-end routes only draw partial line in chaos mode */
  deadEnd?: boolean
  /** Signal travels along this route */
  signal?: boolean
}

export type InfraTopology = {
  nodes: InfraNode[]
  routes: InfraRoute[]
}

export type MarketplaceModeConfig = {
  id: MarketplaceId
  label: string
  nodes: InfraNode[]
  routes: InfraRoute[]
  rhythmClass: string
  /** Micro status row under mode visualization */
  statusSegments: string[]
}
