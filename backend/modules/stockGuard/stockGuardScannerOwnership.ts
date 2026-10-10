/**
 * Single automated Keepa scanner ownership.
 * V2 (global planner + monitor) is authoritative when both flags are on.
 * Legacy scheduler is not deleted; it skips automated source scans while V2 owns them.
 * Admin/manual Keepa routes are not gated here.
 */
import {
  globalKeepaLiveKeepaAllowed,
  loadGlobalKeepaFoundationConfig,
} from "../globalKeepa/globalKeepaConfig"

export type StockGuardScannerMode = "legacy" | "v2"

export function getStockGuardScannerMode(
  cfg = loadGlobalKeepaFoundationConfig()
): StockGuardScannerMode {
  return globalKeepaLiveKeepaAllowed(cfg) ? "v2" : "legacy"
}

export function v2OwnsAutomatedKeepaScan(
  cfg = loadGlobalKeepaFoundationConfig()
): boolean {
  return getStockGuardScannerMode(cfg) === "v2"
}

export function legacyAutomatedKeepaScanBlocked(
  cfg = loadGlobalKeepaFoundationConfig()
): boolean {
  return v2OwnsAutomatedKeepaScan(cfg)
}
