/** Dashboard-only reporting window. This must not be used for operational clocks. */
const TURKEY_TIME_ZONE = "Europe/Istanbul"
const CUTOFF_HOUR = 10

type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function turkeyParts(at: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TURKEY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at)
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find(part => part.type === type)?.value ?? "0")
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  }
}

function turkeyOffsetMs(at: Date): number {
  const p = turkeyParts(at)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at.getTime()
}

function turkeyWallClockToUtc(parts: ZonedParts): Date {
  const wallClockMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  let result = new Date(wallClockMs)
  // Resolve the local wall clock through the dashboard's timezone only. A second
  // pass keeps this correct if this timezone ever changes its UTC offset.
  result = new Date(wallClockMs - turkeyOffsetMs(result))
  return new Date(wallClockMs - turkeyOffsetMs(result))
}

/** The dashboard business day is 10:00 Turkey time through the next 10:00. */
export function getDashboardTodayRange(now = new Date()): { start: Date; end: Date } {
  const local = turkeyParts(now)
  const cutoffDay = new Date(Date.UTC(local.year, local.month - 1, local.day))
  if (local.hour < CUTOFF_HOUR) cutoffDay.setUTCDate(cutoffDay.getUTCDate() - 1)
  const start = turkeyWallClockToUtc({
    year: cutoffDay.getUTCFullYear(),
    month: cutoffDay.getUTCMonth() + 1,
    day: cutoffDay.getUTCDate(),
    hour: CUTOFF_HOUR,
    minute: 0,
    second: 0,
  })
  return { start, end: now }
}

export type DashboardPeriod = "today" | "week" | "month"

/** Dashboard-only reporting ranges. `today` intentionally keeps the 10:00 TR cutoff. */
export function getDashboardPeriodRange(period: DashboardPeriod, now = new Date()): { start: Date; end: Date } {
  if (period === "today") return getDashboardTodayRange(now)
  const start = new Date(now)
  start.setUTCDate(start.getUTCDate() - (period === "week" ? 7 : 30))
  return { start, end: now }
}

export function isInDashboardToday(at: Date, range: { start: Date; end: Date }): boolean {
  return at.getTime() >= range.start.getTime() && at.getTime() <= range.end.getTime()
}
