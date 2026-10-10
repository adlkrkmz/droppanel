import type { Request, Response } from "express"
import { loadAmazonScanConfig } from "./amazonScanConfig"
import { amazonScanWorkerAuthConfigured, authorizeAmazonScanWorker } from "./amazonScanWorkerAuth"
import { evaluateAmazonScanWorkerGate, type AmazonScanWorkerRoute } from "./amazonScanWorkerAccess"
import {
  claimNextScanJob,
  completeScanJob,
  failScanJob,
  markScanJobRunning,
  recoverExpiredRunningScanJobs,
  renewScanJobLease,
  upsertScanHeartbeat,
} from "./amazonScanJobQueue"
import { sanitizeAmazonScanHostTelemetry } from "./amazonScanHostTelemetry"

function workerIdFrom(body: Record<string, unknown>, fallback: string): string {
  const id = String(body.workerId ?? "").trim()
  return id || fallback
}

function applyGate(req: Request, res: Response, route: AmazonScanWorkerRoute): boolean {
  const cfg = loadAmazonScanConfig()
  const tokenConfigured = amazonScanWorkerAuthConfigured()
  const auth = authorizeAmazonScanWorker(
    typeof req.headers.authorization === "string" ? req.headers.authorization : undefined
  )
  const decision = evaluateAmazonScanWorkerGate({
    cfg,
    route,
    tokenConfigured,
    tokenOk: auth.ok,
  })
  if (decision.kind === "proceed") return true
  if (decision.kind === "claim_disabled") {
    res.status(decision.status).json(decision.body)
    return false
  }
  res.status(decision.status).json({ ok: false, error: decision.error })
  return false
}

export function registerAmazonScanWorkerRoutes(app: { post: Function }): void {
  app.post("/internal/amazon-scan/heartbeat", async (req: Request, res: Response) => {
    if (!applyGate(req, res, "heartbeat")) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const workerId = workerIdFrom(body, "amazon-scan-worker")
    const tel = sanitizeAmazonScanHostTelemetry(body.hostTelemetry)
    await upsertScanHeartbeat({
      workerId,
      status: String(body.status ?? "ONLINE"),
      browserRunning: body.browserRunning === true,
      currentJobId: body.currentJobId != null ? Number(body.currentJobId) : null,
      lastError: typeof body.lastError === "string" ? body.lastError : null,
      pauseReason: typeof body.pauseReason === "string" ? body.pauseReason : null,
      hostTelemetry: tel,
    })
    await recoverExpiredRunningScanJobs(10).catch(() => undefined)
    res.json({ ok: true })
  })

  app.post("/internal/amazon-scan/claim-next", async (req: Request, res: Response) => {
    if (!applyGate(req, res, "claim-next")) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const workerId = workerIdFrom(body, "")
    if (!workerId) {
      res.status(400).json({ ok: false, error: "workerId required" })
      return
    }
    const preferConfirm = body.preferConfirm === true
    const job = await claimNextScanJob({ workerId, preferConfirm })
    if (!job) {
      res.json({ ok: true, job: null, message: "NO_WORK" })
      return
    }
    const cfg = loadAmazonScanConfig()
    res.json({
      ok: true,
      job: {
        jobId: job.id,
        asin: job.asin,
        amazonUrl: `https://www.amazon.com/dp/${job.asin}?th=1`,
        kind: job.kind,
        marketplace: job.marketplace,
        deliveryZip: job.deliveryZip,
        sessionClass: job.sessionClass,
        leaseToken: job.leaseToken,
        leaseSeconds: cfg.leaseSeconds,
        requireFreshNavigation:
          job.requireFreshNav ||
          job.kind === "CONFIRM" ||
          job.kind === "KEEPA_VERIFY_PRIMARY" ||
          job.kind === "KEEPA_VERIFY_CONFIRM",
      },
    })
  })

  app.post("/internal/amazon-scan/running", async (req: Request, res: Response) => {
    if (!applyGate(req, res, "running")) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const ok = await markScanJobRunning({
      jobId: Number(body.jobId),
      workerId: workerIdFrom(body, ""),
      leaseToken: String(body.leaseToken ?? ""),
    })
    res.status(ok ? 200 : 409).json({ ok })
  })

  app.post("/internal/amazon-scan/lease-renew", async (req: Request, res: Response) => {
    if (!applyGate(req, res, "lease-renew")) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const ok = await renewScanJobLease({
      jobId: Number(body.jobId),
      workerId: workerIdFrom(body, ""),
      leaseToken: String(body.leaseToken ?? ""),
    })
    res.status(ok ? 200 : 409).json({ ok })
  })

  app.post("/internal/amazon-scan/result", async (req: Request, res: Response) => {
    if (!applyGate(req, res, "result")) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const observedAt = body.observedAt ? new Date(String(body.observedAt)) : new Date()
    const payload = (body.payload && typeof body.payload === "object" ? body.payload : {}) as Record<string, unknown>
    const done = await completeScanJob({
      jobId: Number(body.jobId),
      workerId: workerIdFrom(body, ""),
      leaseToken: String(body.leaseToken ?? ""),
      payload,
      observedAt,
    })
    if (done.ok === false) {
      res.status(409).json({ ok: false, error: done.code })
      return
    }
    res.json({ ok: true, alreadyCompleted: done.alreadyCompleted === true })
  })

  app.post("/internal/amazon-scan/fail", async (req: Request, res: Response) => {
    if (!applyGate(req, res, "fail")) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const status = await failScanJob({
      jobId: Number(body.jobId),
      workerId: workerIdFrom(body, ""),
      leaseToken: String(body.leaseToken ?? ""),
      code: String(body.code ?? "WORKER_ERROR"),
      message: String(body.message ?? "fail"),
    })
    if (status.status === "STALE_LEASE") {
      res.status(409).json({ ok: false, error: "STALE_LEASE" })
      return
    }
    res.json({ ok: true, status: status.status })
  })
}
