export type DesktopAgentDeviceStatus = "ONLINE" | "OFFLINE" | "REVOKED"

export type DesktopAgentDeviceRow = {
  id: number
  deviceId: string
  workspaceId: string
  userId: string
  deviceName: string
  status: DesktopAgentDeviceStatus
  version: string | null
  lastHeartbeatAt: Date | null
  lastObservationAt: Date | null
  scannedCount: number
  successCountToday: number
  failureCountToday: number
  createdAt: Date
}

export type DesktopAgentAsinItem = {
  asin: string
  globalAsinId: number | null
  priority: 0 | 1 | 2
  cadenceHours: number
  nextCheckAt: string | null
  listingCount: number
}

export type DesktopObservationBody = {
  deviceId: string
  requestedAsin: string
  actualAsin?: string | null
  status?: string | null
  offerCondition?: string | null
  price?: number | null
  prime?: boolean | null
  shipsFrom?: string | null
  soldBy?: string | null
  availability?: string | null
  inStock?: boolean | null
  newOfferAvailable?: boolean | null
  productNotFound?: boolean | null
  pageExists?: boolean | null
  offerLabel?: string | null
  finalUrl?: string | null
  observationId?: string | null
  checkedAt?: string | null
  alternateOffer?: Record<string, unknown> | null
}
