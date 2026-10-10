import {
  HEARTBEAT_MAX_MS,
  HEARTBEAT_MIN_MS,
  MAX_ACTIVE_SIGNALS,
  SIGNAL_TRAVEL_MAX_S,
  SIGNAL_TRAVEL_MIN_S,
} from './constants'

/** Random delay between heartbeat cycles (4–7s). */
export function randomHeartbeatMs(): number {
  return (
    HEARTBEAT_MIN_MS +
    Math.floor(Math.random() * (HEARTBEAT_MAX_MS - HEARTBEAT_MIN_MS + 1))
  )
}

/** CSS duration for signal travel along active route (3–6s). */
export function randomSignalTravelSec(): number {
  const span = SIGNAL_TRAVEL_MAX_S - SIGNAL_TRAVEL_MIN_S
  return SIGNAL_TRAVEL_MIN_S + Math.random() * span
}

/** Pick 1–2 distinct route ids for simultaneous signals. */
export function pickActiveSignalIds(routeIds: string[]): string[] {
  if (routeIds.length === 0) return []
  const count =
    routeIds.length > 1 && Math.random() > 0.35
      ? Math.min(MAX_ACTIVE_SIGNALS, 2)
      : 1
  const pool = [...routeIds]
  const picked: string[] = []
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length)
    picked.push(pool.splice(idx, 1)[0])
  }
  return picked
}
