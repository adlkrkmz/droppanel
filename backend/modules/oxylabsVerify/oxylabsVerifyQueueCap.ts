export const OXYLABS_ACTIVE_JOB_STATUSES = [
  "PENDING",
  "CLAIMED",
  "RUNNING",
  "WAITING_FOR_WORKER",
  "RETRYABLE",
] as const

export function oxylabsFeederRemaining(input: {
  canaryMax: number
  uniqueReservationCount: number
  unreservedActiveOxylabsJobCount: number
}): number {
  const cap = Number.isFinite(input.canaryMax) ? Math.max(0, Math.floor(input.canaryMax)) : 0
  const reserved = Number.isFinite(input.uniqueReservationCount)
    ? Math.max(0, Math.floor(input.uniqueReservationCount))
    : 0
  const unreserved = Number.isFinite(input.unreservedActiveOxylabsJobCount)
    ? Math.max(0, Math.floor(input.unreservedActiveOxylabsJobCount))
    : 0
  return Math.max(0, cap - reserved - unreserved)
}

export function simulateOxylabsPrimaryFeederTicks(input: {
  candidateCount: number
  canaryMax: number
  uniqueReservationCount?: number
  unreservedActiveOxylabsJobCount?: number
  ticks?: number
}): { created: number[]; totalActiveUnreserved: number; remainingAfter: number } {
  let reserved = input.uniqueReservationCount ?? 0
  let unreserved = input.unreservedActiveOxylabsJobCount ?? 0
  const created: number[] = []
  const ticks = input.ticks ?? 1
  let leftoverCandidates = input.candidateCount
  for (let t = 0; t < ticks; t++) {
    const remaining = oxylabsFeederRemaining({
      canaryMax: input.canaryMax,
      uniqueReservationCount: reserved,
      unreservedActiveOxylabsJobCount: unreserved,
    })
    const n = Math.min(remaining, leftoverCandidates)
    leftoverCandidates -= n
    unreserved += n
    created.push(n)
  }
  return {
    created,
    totalActiveUnreserved: unreserved,
    remainingAfter: oxylabsFeederRemaining({
      canaryMax: input.canaryMax,
      uniqueReservationCount: reserved,
      unreservedActiveOxylabsJobCount: unreserved,
    }),
  }
}
