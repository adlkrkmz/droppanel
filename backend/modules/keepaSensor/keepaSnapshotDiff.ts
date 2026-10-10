import type { KeepaMonitoredSnapshot } from "./keepaMonitoredSnapshot"
import { monitoredSnapshotFingerprint } from "./keepaMonitoredSnapshot"

export type KeepaReadOutcome = "OK" | "API_ERROR" | "PARSE_FAILURE" | "STALE_INCOMPLETE" | "TOKEN_MISSING"

export type KeepaCandidateStatus =
  | "PENDING"
  | "RETRYABLE"
  | "SUPERSEDED"
  | "NO_BUSINESS_CHANGE"
  | "MATCHED"
  | "CONFLICT"
  | "COOLDOWN"

export type KeepaDiffResult =
  | { kind: "baseline"; snapshot: KeepaMonitoredSnapshot; fingerprint: string }
  | { kind: "unchanged"; snapshot: KeepaMonitoredSnapshot; fingerprint: string }
  | { kind: "changed"; snapshot: KeepaMonitoredSnapshot; fingerprint: string; changedKeys: string[] }
  | { kind: "ignored_error"; reason: KeepaReadOutcome }

const MONITORED_KEYS: (keyof KeepaMonitoredSnapshot)[] = [
  "buyBoxPriceUsd",
  "newPriceUsd",
  "amazonPriceUsd",
  "newFbaCount",
  "newFbmCount",
  "primeExclusivePriceUsd",
  "buyBoxIsPrimeExclusive",
  "buyBoxSellerId",
  "availability",
  "requestedAsin",
  "returnedAsin",
  "requestedAsinPresent",
  "returnedAsinMismatch",
  "parentAsin",
  "variationAsinsFingerprint",
  "productUnavailable",
]

export function equalCommercial(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true
  if (typeof a === "number" && typeof b === "number") return Math.round(a * 100) === Math.round(b * 100)
  return a === b
}

export function diffMonitoredSnapshots(
  prev: KeepaMonitoredSnapshot | null,
  next: KeepaMonitoredSnapshot
): string[] {
  if (!prev) return []
  const changed: string[] = []
  for (const key of MONITORED_KEYS) {
    if (!equalCommercial(prev[key], next[key])) changed.push(key)
  }
  return changed
}

export function evaluateKeepaRead(input: {
  outcome: KeepaReadOutcome
  snapshot: KeepaMonitoredSnapshot | null
  previous: KeepaMonitoredSnapshot | null
}): KeepaDiffResult {
  if (input.outcome !== "OK" || !input.snapshot) {
    return { kind: "ignored_error", reason: input.outcome === "OK" ? "PARSE_FAILURE" : input.outcome }
  }
  const fingerprint = monitoredSnapshotFingerprint(input.snapshot)
  if (!input.previous) {
    return { kind: "baseline", snapshot: input.snapshot, fingerprint }
  }
  const changedKeys = diffMonitoredSnapshots(input.previous, input.snapshot)
  if (changedKeys.length === 0) {
    return { kind: "unchanged", snapshot: input.snapshot, fingerprint }
  }
  return { kind: "changed", snapshot: input.snapshot, fingerprint, changedKeys }
}

export function nextCandidateTransition(input: {
  pending: { fingerprint: string; status: KeepaCandidateStatus } | null
  diff: KeepaDiffResult
  nowMs: number
  cooldownUntilMs?: number | null
}): { action: "none" | "create" | "supersede_and_create" | "keep_retry"; fingerprint?: string } {
  if (input.diff.kind === "ignored_error") return { action: "none" }
  if (input.diff.kind === "baseline" || input.diff.kind === "unchanged") return { action: "none" }
  const fp = input.diff.fingerprint
  const pending = input.pending
  if (!pending) return { action: "create", fingerprint: fp }
  if (pending.status === "RETRYABLE") {
    if (pending.fingerprint === fp) return { action: "keep_retry", fingerprint: fp }
    return { action: "supersede_and_create", fingerprint: fp }
  }
  if (pending.status === "PENDING" && pending.fingerprint !== fp) {
    return { action: "supersede_and_create", fingerprint: fp }
  }
  if (pending.status === "PENDING" && pending.fingerprint === fp) return { action: "none" }
  if (pending.status === "NO_BUSINESS_CHANGE" && pending.fingerprint === fp) {
    if (input.cooldownUntilMs != null && input.nowMs < input.cooldownUntilMs) return { action: "none" }
    return { action: "create", fingerprint: fp }
  }
  if (pending.status === "COOLDOWN" && pending.fingerprint === fp) {
    if (input.cooldownUntilMs != null && input.nowMs < input.cooldownUntilMs) return { action: "none" }
    return { action: "create", fingerprint: fp }
  }
  if (pending.fingerprint === fp) return { action: "none" }
  return { action: "create", fingerprint: fp }
}

export function keepaCommercialFingerprint(s: {
  amazonCents: number | null
  newCents: number | null
  buyBoxCents: number | null
  primeExclusiveCents: number | null
  availability: string | null
  buyBoxIsPrimeExclusive: boolean | null
  newFbaCount: number | null
  newFbmCount: number | null
  requestedAsin?: string | null
  returnedAsin?: string | null
  requestedAsinPresent?: boolean | null
  returnedAsinMismatch?: boolean | null
  parentAsin?: string | null
  variationAsinsFingerprint?: string | null
  productUnavailable?: boolean | null
}): string {
  return JSON.stringify({
    amazonCents: s.amazonCents,
    newCents: s.newCents,
    buyBoxCents: s.buyBoxCents,
    primeExclusiveCents: s.primeExclusiveCents,
    availability: s.availability ?? null,
    buyBoxIsPrimeExclusive: s.buyBoxIsPrimeExclusive,
    newFbaCount: s.newFbaCount,
    newFbmCount: s.newFbmCount,
    requestedAsin: s.requestedAsin ?? null,
    returnedAsin: s.returnedAsin ?? null,
    requestedAsinPresent: s.requestedAsinPresent ?? null,
    returnedAsinMismatch: s.returnedAsinMismatch ?? null,
    parentAsin: s.parentAsin ?? null,
    variationAsinsFingerprint: s.variationAsinsFingerprint ?? null,
    productUnavailable: s.productUnavailable ?? null,
  })
}

export function keepaSnapshotTrigger(
  prev: ReturnType<typeof JSON.parse> | null,
  next: {
    amazonCents: number | null
    newCents: number | null
    buyBoxCents: number | null
    primeExclusiveCents: number | null
    availability: string | null
    buyBoxIsPrimeExclusive: boolean | null
    newFbaCount: number | null
    newFbmCount: number | null
    requestedAsin?: string | null
    returnedAsin?: string | null
    requestedAsinPresent?: boolean | null
    returnedAsinMismatch?: boolean | null
    parentAsin?: string | null
    variationAsinsFingerprint?: string | null
    productUnavailable?: boolean | null
  }
): "baseline" | "unchanged" | "changed" {
  if (!prev) return "baseline"
  const prevFp = keepaCommercialFingerprint({
    amazonCents: prev.amazonCents ?? null,
    newCents: prev.newCents ?? null,
    buyBoxCents: prev.buyBoxCents ?? null,
    primeExclusiveCents: prev.primeExclusiveCents ?? null,
    availability: prev.availability ?? null,
    buyBoxIsPrimeExclusive: prev.buyBoxIsPrimeExclusive ?? null,
    newFbaCount: prev.newFbaCount ?? null,
    newFbmCount: prev.newFbmCount ?? null,
    requestedAsin: prev.requestedAsin ?? null,
    returnedAsin: prev.returnedAsin ?? null,
    requestedAsinPresent: prev.requestedAsinPresent ?? null,
    returnedAsinMismatch: prev.returnedAsinMismatch ?? null,
    parentAsin: prev.parentAsin ?? null,
    variationAsinsFingerprint: prev.variationAsinsFingerprint ?? null,
    productUnavailable: prev.productUnavailable ?? null,
  })
  return prevFp === keepaCommercialFingerprint(next) ? "unchanged" : "changed"
}

export function applyBrowserCandidateOutcome(input: {
  status: KeepaCandidateStatus
  browser: "INCOMPLETE" | "NO_BUSINESS_CHANGE" | "MATCHED" | "CONFLICT" | "UNKNOWN"
}): KeepaCandidateStatus {
  if (input.browser === "INCOMPLETE" || input.browser === "UNKNOWN") return "RETRYABLE"
  if (input.browser === "NO_BUSINESS_CHANGE") return "NO_BUSINESS_CHANGE"
  if (input.browser === "CONFLICT") return "CONFLICT"
  if (input.browser === "MATCHED") return "MATCHED"
  return input.status
}
