export const KEEPA_SYNC_EVENT_TYPES = [
  "ASIN_UPSERT",
  "CONSUMER_ATTACHED",
  "CONSUMER_DETACHED",
  "ASIN_REMOVED",
  "QTY_ZERO_PAUSED",
  "QTY_POSITIVE_RESUMED",
  "SOLD_PRIORITY_CHANGED",
] as const

export type KeepaSyncEventType = (typeof KEEPA_SYNC_EVENT_TYPES)[number]

export type KeepaAsinRegistryStatus = "ACTIVE" | "PAUSED_QTY_ZERO" | "REMOVED"
export type KeepaAsinPriority = "SOLD" | "STANDARD"

export type KeepaAsinProjection = {
  asin: string
  activeConsumerCount: number
  listingCount: number
  status: KeepaAsinRegistryStatus
  priority: KeepaAsinPriority
  cadenceHours: number
  soldPriority: boolean
  qtyPaused: boolean
}

export type KeepaSyncEventPayload = KeepaAsinProjection & {
  eventType: KeepaSyncEventType
  sourceVersion: number
}

export function cadenceHoursForPriority(priority: KeepaAsinPriority, soldHours = 12, standardHours = 24): number {
  const sold = Math.max(12, Number(soldHours) || 12)
  const standard = Math.max(24, Number(standardHours) || 24)
  return priority === "SOLD" ? sold : standard
}

export function projectKeepaAsin(input: {
  asin: string
  listings: Array<{ qty: number; sold: boolean; live: boolean; recovery?: boolean }>
  soldHours?: number
  standardHours?: number
}): KeepaAsinProjection | null {
  const asin = input.asin.trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) return null
  const live = input.listings.filter(l => l.live)
  const active = live.filter(l => l.qty > 0)
  // A bot-zeroed listing is still a consumer: it is deliberately checked at
  // recovery cadence. Manual/unknown zeroes remain paused.
  const recovery = live.filter(l => l.qty <= 0 && l.recovery === true)
  const monitored = [...active, ...recovery]
  const soldPriority = active.some(l => l.sold)
  const listingCount = live.length
  let status: KeepaAsinRegistryStatus
  if (listingCount === 0) status = "REMOVED"
  else if (monitored.length === 0) status = "PAUSED_QTY_ZERO"
  else status = "ACTIVE"
  const priority: KeepaAsinPriority = soldPriority && status === "ACTIVE" ? "SOLD" : "STANDARD"
  return {
    asin,
    activeConsumerCount: monitored.length,
    listingCount,
    status,
    priority,
    cadenceHours: status === "ACTIVE" && active.length === 0
      ? 120
      : cadenceHoursForPriority(priority, input.soldHours ?? 12, input.standardHours ?? 24),
    soldPriority: priority === "SOLD",
    qtyPaused: status === "PAUSED_QTY_ZERO",
  }
}

export function eventsFromProjectionTransition(
  prev: KeepaAsinProjection | null,
  next: KeepaAsinProjection
): KeepaSyncEventType[] {
  const events: KeepaSyncEventType[] = []
  if (!prev || prev.status === "REMOVED") {
    if (next.status === "REMOVED") return []
    events.push("ASIN_UPSERT")
    if (next.activeConsumerCount > 0) events.push("CONSUMER_ATTACHED")
    if (next.status === "PAUSED_QTY_ZERO") events.push("QTY_ZERO_PAUSED")
    if (next.soldPriority) events.push("SOLD_PRIORITY_CHANGED")
    return events
  }
  if (next.status === "REMOVED") {
    events.push("ASIN_REMOVED")
    return events
  }
  if (next.activeConsumerCount > prev.activeConsumerCount) events.push("CONSUMER_ATTACHED")
  if (next.activeConsumerCount < prev.activeConsumerCount) events.push("CONSUMER_DETACHED")
  if (prev.status !== "PAUSED_QTY_ZERO" && next.status === "PAUSED_QTY_ZERO") events.push("QTY_ZERO_PAUSED")
  if (prev.status === "PAUSED_QTY_ZERO" && next.status === "ACTIVE") events.push("QTY_POSITIVE_RESUMED")
  if (prev.soldPriority !== next.soldPriority) events.push("SOLD_PRIORITY_CHANGED")
  if (events.length === 0 && (prev.activeConsumerCount !== next.activeConsumerCount || prev.status !== next.status || prev.priority !== next.priority || prev.cadenceHours !== next.cadenceHours)) {
    events.push("ASIN_UPSERT")
  }
  return events
}

/** Ignore pause-style +365d timestamps so new ACTIVE ASINs are not queued a year out. */
export const KEEPA_QUEUE_HORIZON_MS = 48 * 3600_000

export function nextScanAtForNewAsin(input: { nowMs: number; latestQueueMs: number | null }): number {
  if (input.latestQueueMs == null || !Number.isFinite(input.latestQueueMs)) return input.nowMs
  const horizon = input.nowMs + KEEPA_QUEUE_HORIZON_MS
  const latest = input.latestQueueMs > horizon ? input.nowMs : input.latestQueueMs
  return Math.max(input.nowMs, latest) + 1000
}
