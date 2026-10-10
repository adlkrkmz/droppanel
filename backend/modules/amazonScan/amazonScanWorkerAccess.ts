import type { AmazonScanConfig } from "./amazonScanConfig"

export type AmazonScanWorkerRoute =
  | "heartbeat"
  | "claim-next"
  | "running"
  | "lease-renew"
  | "result"
  | "fail"

export type AmazonScanWorkerGateResult =
  | { kind: "protocol_disabled"; status: 503; error: "SCAN_PROTOCOL_DISABLED" }
  | { kind: "unauthorized"; status: 401; error: "Unauthorized" }
  | { kind: "token_missing"; status: 503; error: "SCAN_WORKER_TOKEN_MISSING" }
  | { kind: "claim_disabled"; status: 200; body: { ok: true; job: null; message: "REMOTE_WORKERS_DISABLED" } }
  | { kind: "proceed" }

/**
 * Protocol opens heartbeat/auth and in-flight lease completion.
 * ROUTINE/CONFIRM claims need AMAZON_SCAN_REMOTE_WORKERS_ENABLED.
 * Keepa verify claims may open independently via KEEPA_VERIFY_CLAIM_ENABLED;
 * SQL still binds workerId → a single kind.
 */
export function evaluateAmazonScanWorkerGate(input: {
  cfg: Pick<AmazonScanConfig, "remoteProtocolEnabled" | "remoteWorkersEnabled"> & {
    keepaVerifyClaimEnabled?: boolean
  }
  route: AmazonScanWorkerRoute
  tokenConfigured: boolean
  tokenOk: boolean
}): AmazonScanWorkerGateResult {
  if (!input.cfg.remoteProtocolEnabled) {
    return { kind: "protocol_disabled", status: 503, error: "SCAN_PROTOCOL_DISABLED" }
  }
  if (!input.tokenConfigured) {
    return { kind: "token_missing", status: 503, error: "SCAN_WORKER_TOKEN_MISSING" }
  }
  if (!input.tokenOk) {
    return { kind: "unauthorized", status: 401, error: "Unauthorized" }
  }
  const claimOpen = input.cfg.remoteWorkersEnabled === true || input.cfg.keepaVerifyClaimEnabled === true
  if (input.route === "claim-next" && !claimOpen) {
    return {
      kind: "claim_disabled",
      status: 200,
      body: { ok: true, job: null, message: "REMOTE_WORKERS_DISABLED" },
    }
  }
  return { kind: "proceed" }
}

export function amazonScanRemoteClaimOpen(
  cfg: Pick<AmazonScanConfig, "remoteProtocolEnabled" | "remoteWorkersEnabled">
): boolean {
  return cfg.remoteProtocolEnabled === true && cfg.remoteWorkersEnabled === true
}

export function amazonScanVerifyClaimOpen(
  cfg: Pick<AmazonScanConfig, "remoteProtocolEnabled" | "keepaVerifyClaimEnabled">
): boolean {
  return cfg.remoteProtocolEnabled === true && cfg.keepaVerifyClaimEnabled === true
}
