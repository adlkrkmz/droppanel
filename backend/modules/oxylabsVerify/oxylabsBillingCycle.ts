export function addUtcCalendarMonths(anchor: Date, months: number): Date {
  const y = anchor.getUTCFullYear()
  const m0 = anchor.getUTCMonth()
  const total = m0 + months
  const y2 = y + Math.floor(total / 12)
  let m2 = total % 12
  if (m2 < 0) m2 += 12
  const dim = new Date(Date.UTC(y2, m2 + 1, 0)).getUTCDate()
  const day = Math.min(anchor.getUTCDate(), dim)
  return new Date(
    Date.UTC(
      y2,
      m2,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds()
    )
  )
}

export function oxylabsBillingCycleWindow(
  anchor: Date,
  now: Date
): { start: Date; end: Date; index: number } {
  const a = anchor.getTime()
  const n = now.getTime()
  if (!Number.isFinite(a) || !Number.isFinite(n)) {
    return { start: anchor, end: addUtcCalendarMonths(anchor, 1), index: 0 }
  }
  let lo = 0
  let hi = 1
  while (addUtcCalendarMonths(anchor, hi).getTime() <= n && hi < 12000) {
    lo = hi
    hi = Math.min(12000, hi * 2)
  }
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (addUtcCalendarMonths(anchor, mid).getTime() <= n) lo = mid
    else hi = mid
  }
  const start = addUtcCalendarMonths(anchor, lo)
  const end = addUtcCalendarMonths(anchor, lo + 1)
  return { start, end, index: lo }
}

export function oxylabsCycleRemaining(input: {
  monthlyLimit: number
  currentCycleReservations: number
  unreservedActivePrimaryJobs: number
}): number {
  return Math.max(
    0,
    Math.floor(input.monthlyLimit) -
      Math.max(0, Math.floor(input.currentCycleReservations)) -
      Math.max(0, Math.floor(input.unreservedActivePrimaryJobs))
  )
}

/** New provider reservation allowed when cycle reservation count is below monthly limit. */
export function oxylabsCycleAllowsNewReservation(input: {
  monthlyLimit: number
  currentCycleReservations: number
}): boolean {
  return Math.max(0, Math.floor(input.currentCycleReservations)) < Math.max(0, Math.floor(input.monthlyLimit))
}
