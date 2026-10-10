import { amazonScanRecheckHours, loadAmazonScanConfig } from "../modules/amazonScan/amazonScanConfig"
import { buildAmazonScanKey, scanContextsCompatible, scanSpreadSeconds } from "../modules/amazonScan/amazonScanKey"
import { authorizeAmazonScanWorker } from "../modules/amazonScan/amazonScanWorkerAuth"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const sold = amazonScanRecheckHours(0, { ...loadAmazonScanConfig(), soldRecheckHours: 12, otherRecheckHours: 24 })
const other = amazonScanRecheckHours(2, { ...loadAmazonScanConfig(), soldRecheckHours: 12, otherRecheckHours: 24 })
assert(sold === 12, `sold recheck hours (saat) ${sold}`)
assert(other === 24, `other recheck hours (saat) ${other}`)
console.log("sold=priority 0 when total_sold>0 OR sold_30d>0 → 12 saat; diğerleri 24 saat")

const k1 = buildAmazonScanKey({ asin: "b00test123", marketplace: "us", deliveryZip: "10001", sessionClass: "PUBLIC_UNAUTH" })
const k2 = buildAmazonScanKey({ asin: "B00TEST123", marketplace: "US", deliveryZip: "10001", sessionClass: "PUBLIC_UNAUTH" })
assert(k1 === k2, "scan key case")
assert(k1 !== buildAmazonScanKey({ asin: "B00TEST123", marketplace: "US", deliveryZip: "90210", sessionClass: "PUBLIC_UNAUTH" }), "zip in key")
assert(
  !scanContextsCompatible(
    { asin: "B00TEST123", marketplace: "US", deliveryZip: "10001", sessionClass: "PUBLIC_UNAUTH" },
    { asin: "B00TEST123", marketplace: "US", deliveryZip: "10001", sessionClass: "AUTH" }
  ),
  "session class"
)

const a = scanSpreadSeconds("B00TEST123", 3600)
const b = scanSpreadSeconds("B00TEST123", 3600)
assert(a === b && a >= 0 && a < 3600, "spread stable")

process.env.AMAZON_BROWSER_PACE_MS = "5000"
const { amazonScanWorkerPaceMs } = require("../modules/amazonPublicWorker/amazonPublicWorkerPool") as {
  amazonScanWorkerPaceMs: (slot: string) => number
}
assert(amazonScanWorkerPaceMs("A") === 5000, "pace A default+jitter0")
assert(amazonScanWorkerPaceMs("B") === 5000 + 350, "pace B jitter 350")
assert(amazonScanWorkerPaceMs("B") - amazonScanWorkerPaceMs("A") <= 1500, "jitter cap")

process.env.AMAZON_SCAN_WORKER_TOKEN = "x".repeat(32)
assert(authorizeAmazonScanWorker("Bearer " + "x".repeat(32)).ok, "token ok")
assert(!authorizeAmazonScanWorker("Bearer " + "y".repeat(32)).ok, "token reject")

const {
  evaluateAmazonScanWorkerGate,
  amazonScanRemoteClaimOpen,
} = require("../modules/amazonScan/amazonScanWorkerAccess") as typeof import("../modules/amazonScan/amazonScanWorkerAccess")

const routes = ["heartbeat", "claim-next", "running", "lease-renew", "result", "fail"] as const
for (const route of routes) {
  const d = evaluateAmazonScanWorkerGate({
    cfg: { remoteProtocolEnabled: false, remoteWorkersEnabled: true },
    route,
    tokenConfigured: true,
    tokenOk: true,
  })
  assert(d.kind === "protocol_disabled" && d.status === 503, `protocol false ${route}`)
}

const protocolOnly = { remoteProtocolEnabled: true, remoteWorkersEnabled: false }
assert(
  evaluateAmazonScanWorkerGate({
    cfg: protocolOnly,
    route: "heartbeat",
    tokenConfigured: true,
    tokenOk: true,
  }).kind === "proceed",
  "heartbeat when remote false"
)
const claimOff = evaluateAmazonScanWorkerGate({
  cfg: protocolOnly,
  route: "claim-next",
  tokenConfigured: true,
  tokenOk: true,
})
assert(claimOff.kind === "claim_disabled" && claimOff.status === 200, "claim disabled 200")
assert(claimOff.kind === "claim_disabled" && claimOff.body.job === null && claimOff.body.message === "REMOTE_WORKERS_DISABLED", "claim no-work body")
for (const route of ["running", "lease-renew", "result", "fail"] as const) {
  assert(
    evaluateAmazonScanWorkerGate({
      cfg: protocolOnly,
      route,
      tokenConfigured: true,
      tokenOk: true,
    }).kind === "proceed",
    `owned lease ${route}`
  )
}

const live = { remoteProtocolEnabled: true, remoteWorkersEnabled: true }
assert(
  evaluateAmazonScanWorkerGate({
    cfg: live,
    route: "claim-next",
    tokenConfigured: true,
    tokenOk: true,
  }).kind === "proceed",
  "claim when remote true"
)
assert(
  evaluateAmazonScanWorkerGate({
    cfg: { remoteProtocolEnabled: true, remoteWorkersEnabled: false, keepaVerifyClaimEnabled: true },
    route: "claim-next",
    tokenConfigured: true,
    tokenOk: true,
  }).kind === "proceed",
  "verify claim independent of remote workers"
)
assert(!amazonScanRemoteClaimOpen(protocolOnly), "claim closed helper")
assert(
  evaluateAmazonScanWorkerGate({
    cfg: live,
    route: "claim-next",
    tokenConfigured: true,
    tokenOk: false,
  }).kind === "unauthorized",
  "bad token 401"
)

const prevPlanner = process.env.AMAZON_BROWSER_PLANNER_ENABLED
const prevApply = process.env.AMAZON_SCAN_APPLY_PROCESSOR_ENABLED
process.env.AMAZON_BROWSER_PLANNER_ENABLED = "false"
process.env.AMAZON_SCAN_APPLY_PROCESSOR_ENABLED = "false"
const gatedCfg = loadAmazonScanConfig()
assert(gatedCfg.plannerEnabled === false, "planner stays false")
assert(gatedCfg.applyProcessorEnabled === false, "apply stays false")
if (prevPlanner === undefined) delete process.env.AMAZON_BROWSER_PLANNER_ENABLED
else process.env.AMAZON_BROWSER_PLANNER_ENABLED = prevPlanner
if (prevApply === undefined) delete process.env.AMAZON_SCAN_APPLY_PROCESSOR_ENABLED
else process.env.AMAZON_SCAN_APPLY_PROCESSOR_ENABLED = prevApply

const {
  resolveScanClaimKind,
  scanJobClaimableByWorker,
  amazonScanConfirmMaxAgeMs,
  evaluateConfirmFreshness,
  evaluateScanApplyMutationGate,
  isScanObservationIncomplete,
} = require("../modules/amazonScan/amazonScanApplyPolicy") as typeof import("../modules/amazonScan/amazonScanApplyPolicy")

assert(resolveScanClaimKind("amazon-public-browser-worker-A") === "ROUTINE", "A routine")
assert(resolveScanClaimKind("amazon-public-browser-worker-B") === "ROUTINE", "B routine")
assert(resolveScanClaimKind("amazon-scan-confirm-C") === "CONFIRM", "C confirm")
assert(resolveScanClaimKind("amazon-scan-worker") === null, "unknown id")
assert(scanJobClaimableByWorker("amazon-public-browser-worker-A", "ROUTINE"), "A claims ROUTINE")
assert(!scanJobClaimableByWorker("amazon-public-browser-worker-A", "CONFIRM"), "A no CONFIRM")
assert(scanJobClaimableByWorker("amazon-scan-confirm-C", "CONFIRM"), "C claims CONFIRM")
assert(!scanJobClaimableByWorker("amazon-scan-confirm-C", "ROUTINE"), "C no ROUTINE")
assert(resolveScanClaimKind("amazon-keepa-verify-primary-A") === "KEEPA_VERIFY_PRIMARY", "verify primary id")
assert(resolveScanClaimKind("amazon-keepa-verify-confirm-C") === "KEEPA_VERIFY_CONFIRM", "verify confirm id")
assert(scanJobClaimableByWorker("amazon-keepa-verify-primary-A", "KEEPA_VERIFY_PRIMARY"), "A claims PRIMARY")
assert(!scanJobClaimableByWorker("amazon-keepa-verify-primary-A", "KEEPA_VERIFY_CONFIRM"), "A no verify CONFIRM")
assert(scanJobClaimableByWorker("amazon-keepa-verify-confirm-C", "KEEPA_VERIFY_CONFIRM"), "C claims verify CONFIRM")
assert(!scanJobClaimableByWorker("amazon-keepa-verify-confirm-C", "KEEPA_VERIFY_PRIMARY"), "C no PRIMARY")
assert(!scanJobClaimableByWorker("amazon-scan-worker", "KEEPA_VERIFY_PRIMARY"), "unknown no verify")

assert(amazonScanConfirmMaxAgeMs("600000") === 600000, "max age default")
assert(amazonScanConfirmMaxAgeMs("") === 600000, "max age empty")
const now = Date.parse("2026-09-20T16:00:00Z")
assert(
  evaluateConfirmFreshness({
    nowMs: now,
    parentObservedAtMs: now - 60_000,
    confirmObservedAtMs: now - 1_000,
    maxAgeMs: 600_000,
  }) === null,
  "fresh confirm"
)
assert(
  evaluateConfirmFreshness({
    nowMs: now,
    parentObservedAtMs: now - 700_000,
    confirmObservedAtMs: now - 1_000,
    maxAgeMs: 600_000,
  }) === "CONFIRM_PARENT_STALE",
  "parent stale"
)
assert(
  evaluateConfirmFreshness({
    nowMs: now,
    parentObservedAtMs: now - 60_000,
    confirmObservedAtMs: now - 700_000,
    maxAgeMs: 600_000,
  }) === "CONFIRM_RESULT_STALE",
  "result stale"
)

const freshConfirm = evaluateScanApplyMutationGate({
  kind: "CONFIRM",
  incomplete: false,
  decisionOutcome: "VALID_SOURCE",
  fingerprintMatch: true,
  hasParent: true,
  parentObservedAtMs: now - 60_000,
  resultObservedAtMs: now - 1_000,
  nowMs: now,
  maxAgeMs: 600_000,
  mutationCandidate: true,
})
assert(freshConfirm.allowEbayMutation === true && freshConfirm.skip === null, "fresh matching CONFIRM mutation gate")

const routineMut = evaluateScanApplyMutationGate({
  kind: "ROUTINE",
  incomplete: false,
  decisionOutcome: "VALID_SOURCE",
  fingerprintMatch: false,
  hasParent: false,
  parentObservedAtMs: null,
  resultObservedAtMs: now,
  nowMs: now,
  maxAgeMs: 600_000,
  mutationCandidate: true,
})
assert(routineMut.allowEbayMutation === false && routineMut.skip === "CONFIRM_QUEUED", "ROUTINE no ebay mutation")

const routineOk = evaluateScanApplyMutationGate({
  kind: "ROUTINE",
  incomplete: false,
  decisionOutcome: "VALID_SOURCE",
  fingerprintMatch: false,
  hasParent: false,
  parentObservedAtMs: null,
  resultObservedAtMs: now,
  nowMs: now,
  maxAgeMs: 600_000,
  mutationCandidate: false,
})
assert(routineOk.allowEbayMutation === false && routineOk.persistObservationOnly === true, "ROUTINE persist only")

assert(
  evaluateScanApplyMutationGate({
    kind: "CONFIRM",
    incomplete: false,
    decisionOutcome: "VALID_SOURCE",
    fingerprintMatch: true,
    hasParent: true,
    parentObservedAtMs: now - 700_000,
    resultObservedAtMs: now - 1_000,
    nowMs: now,
    maxAgeMs: 600_000,
    mutationCandidate: true,
  }).skip === "CONFIRM_PARENT_STALE",
  "stale parent no mutation"
)
assert(
  evaluateScanApplyMutationGate({
    kind: "CONFIRM",
    incomplete: false,
    decisionOutcome: "VALID_SOURCE",
    fingerprintMatch: false,
    hasParent: true,
    parentObservedAtMs: now - 60_000,
    resultObservedAtMs: now - 1_000,
    nowMs: now,
    maxAgeMs: 600_000,
    mutationCandidate: true,
  }).skip === "CONFIRM_CONFLICT",
  "conflict no mutation"
)
assert(
  evaluateScanApplyMutationGate({
    kind: "CONFIRM",
    incomplete: false,
    decisionOutcome: "UNKNOWN",
    fingerprintMatch: true,
    hasParent: true,
    parentObservedAtMs: now - 60_000,
    resultObservedAtMs: now - 1_000,
    nowMs: now,
    maxAgeMs: 600_000,
    mutationCandidate: true,
  }).allowEbayMutation === false,
  "UNKNOWN no mutation"
)
assert(isScanObservationIncomplete({ uncertain: true, metadata: { publicStatus: "AMAZON_INCOMPLETE" } }), "incomplete")
assert(
  evaluateScanApplyMutationGate({
    kind: "CONFIRM",
    incomplete: true,
    decisionOutcome: "VALID_SOURCE",
    fingerprintMatch: true,
    hasParent: true,
    parentObservedAtMs: now - 60_000,
    resultObservedAtMs: now - 1_000,
    nowMs: now,
    maxAgeMs: 600_000,
    mutationCandidate: true,
  }).skip === "INCOMPLETE_NO_MUTATION",
  "INCOMPLETE no mutation"
)

const fs = require("fs") as typeof import("fs")
const queueSrc = fs.readFileSync(require("path").join(__dirname, "../modules/amazonScan/amazonScanJobQueue.ts"), "utf8")
assert(queueSrc.includes("AND t.kind = $5::text"), "SQL kind filter")
assert(queueSrc.includes("resolveScanClaimKind"), "claim uses worker kind")

console.log("amazon-scan-prep-fixtures ok")
