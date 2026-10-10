/**
 * Scalable public Amazon worker pool identity (A/B/C… via env, not hard-coded count).
 * Does not auto-spawn workers — ops sets AMAZON_PUBLIC_WORKER_COUNT + one process per slot.
 */
import path from "node:path"
import { AMAZON_PUBLIC_BROWSER_WORKER_ID } from "../amazonBrowserWorker/amazonBrowserWorkerConstants"

/** Shared pool coordinator row (challenge pause for all slots — no profile rotation). */
export const AMAZON_PUBLIC_BROWSER_POOL_ID = "amazon-public-browser-pool"

const MAX_CONFIGURED_WORKERS = 20

export type PublicWorkerSlot = string

export type PublicWorkerIdentity = {
  slot: PublicWorkerSlot
  /** Claim / lease owner on amazon_price_verification_tasks.worker_id */
  claimWorkerId: string
  /** Heartbeat row worker_id */
  heartbeatWorkerId: string
  /** Persistent Chromium profile directory (one per slot). */
  profileDir: string
  /** Letter used by AmazonPublicWorker logging (A/B/C…). */
  browserName: PublicWorkerSlot
}

export function amazonPublicWorkerCount(): number {
  const n = parseInt(process.env.AMAZON_PUBLIC_WORKER_COUNT ?? "1", 10)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(Math.floor(n), MAX_CONFIGURED_WORKERS)
}

/** Slot letter from 0-based index: 0→A, 1→B, … 25→Z, then A1… */
export function publicWorkerSlotFromIndex(index: number): PublicWorkerSlot {
  if (index < 0) throw new Error(`invalid public worker index ${index}`)
  if (index < 26) return String.fromCharCode(65 + index)
  return `A${index - 25}`
}

export function publicWorkerSlotIndex(slot: string): number {
  const s = String(slot ?? "")
    .trim()
    .toUpperCase()
  if (/^[A-Z]$/.test(s)) return s.charCodeAt(0) - 65
  const m = /^A(\d+)$/.exec(s)
  if (m) return 25 + parseInt(m[1], 10)
  return -1
}

/** Configured slots for count (A.. for N). */
export function configuredPublicWorkerSlots(count = amazonPublicWorkerCount()): PublicWorkerSlot[] {
  const n = Math.max(1, Math.min(MAX_CONFIGURED_WORKERS, count))
  return Array.from({ length: n }, (_, i) => publicWorkerSlotFromIndex(i))
}

export function resolvePublicWorkerSlotFromEnv(): PublicWorkerSlot {
  const raw = String(process.env.AMAZON_PUBLIC_WORKER_SLOT ?? process.env.AMAZON_PUBLIC_WORKER_NAME ?? "A")
    .trim()
    .toUpperCase()
  if (!raw) return "A"
  const idx = publicWorkerSlotIndex(raw)
  if (idx < 0) {
    throw new Error(`Invalid AMAZON_PUBLIC_WORKER_SLOT=${raw}`)
  }
  const max = amazonPublicWorkerCount()
  if (idx >= max) {
    throw new Error(
      `AMAZON_PUBLIC_WORKER_SLOT=${raw} out of range for AMAZON_PUBLIC_WORKER_COUNT=${max}`
    )
  }
  return publicWorkerSlotFromIndex(idx)
}

export function publicWorkerClaimId(slot: PublicWorkerSlot): string {
  return `amazon-public-browser-worker-${slot}`
}

export function amazonScanConfirmWorkerId(slot: PublicWorkerSlot): string {
  return `amazon-scan-confirm-${slot}`
}

export function amazonKeepaVerifyPrimaryWorkerId(slot: PublicWorkerSlot): string {
  return `amazon-keepa-verify-primary-${slot}`
}

export function amazonKeepaVerifyConfirmWorkerId(slot: PublicWorkerSlot): string {
  return `amazon-keepa-verify-confirm-${slot}`
}

/** Canonical AMAZON_SCAN_WORKER_ROLE → workerId. Unknown role falls back to ROUTINE claim id. */
export function amazonScanWorkerIdForRole(role: string, slot: PublicWorkerSlot): string {
  const r = String(role ?? "").trim().toUpperCase()
  if (r === "CONFIRM") return amazonScanConfirmWorkerId(slot)
  if (r === "KEEPA_VERIFY_PRIMARY") return amazonKeepaVerifyPrimaryWorkerId(slot)
  if (r === "KEEPA_VERIFY_CONFIRM") return amazonKeepaVerifyConfirmWorkerId(slot)
  return publicWorkerClaimId(slot)
}

/** Base AMAZON_BROWSER_PACE_MS (default 5000) plus slot jitter 0–1500ms so A/B do not align. */
export function amazonScanWorkerPaceMs(slot: string): number {
  const base = parseInt(process.env.AMAZON_BROWSER_PACE_MS ?? "5000", 10)
  const pace = Number.isFinite(base) && base >= 1000 ? base : 5000
  const idx = Math.max(0, publicWorkerSlotIndex(slot))
  const jitter = (idx * 350) % 1501
  return pace + jitter
}

export function publicWorkerHeartbeatId(slot: PublicWorkerSlot): string {
  return publicWorkerClaimId(slot)
}

export function publicWorkerProfileDir(slot: PublicWorkerSlot): string {
  const fromEnv = process.env.AMAZON_PUBLIC_WORKER_PROFILE_DIR?.trim()
  if (fromEnv) return fromEnv
  return path.resolve(process.cwd(), "var", `amazon-public-browser-profile-${slot}`)
}

export function resolvePublicWorkerIdentity(slot = resolvePublicWorkerSlotFromEnv()): PublicWorkerIdentity {
  const s = String(slot).trim().toUpperCase()
  return {
    slot: s,
    claimWorkerId: publicWorkerClaimId(s),
    heartbeatWorkerId: publicWorkerHeartbeatId(s),
    profileDir: publicWorkerProfileDir(s),
    browserName: s,
  }
}

/** Heartbeat ids for admin: configured slots + legacy single-worker row if present. */
export function publicWorkerHeartbeatIdPrefix(): string {
  return "amazon-public-browser-worker-"
}

export function isPublicPoolHeartbeatId(workerId: string): boolean {
  const id = String(workerId ?? "")
  return (
    id === AMAZON_PUBLIC_BROWSER_POOL_ID ||
    id === AMAZON_PUBLIC_BROWSER_WORKER_ID ||
    id.startsWith(publicWorkerHeartbeatIdPrefix())
  )
}
