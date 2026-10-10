import express from "express"
import type { Request, Response } from "express"
import { sessionCookieName } from "../auth/sessionToken"
import { sanitizeAmazonScanHostTelemetry } from "../amazonScan/amazonScanHostTelemetry"
import { upsertScanHeartbeat } from "../amazonScan/amazonScanJobQueue"
import { loadOxylabsVerifyConfig, oxylabsPricingForbidden } from "./oxylabsVerifyConfig"
import { authorizeOxylabsVerifyWorker, evaluateOxylabsBearerAuth, evaluateOxylabsProtocolGate, oxylabsVerifyWorkerAuthConfigured } from "./oxylabsVerifyAuth"
import { resolveOxylabsVerifyClaimKind } from "./oxylabsVerifyKinds"
import {
  claimNextOxylabsJob,
  completeOxylabsVerifyJob,
  failOxylabsVerifyJob,
  markOxylabsJobRunning,
} from "./oxylabsVerifyJobQueue"
import { applyOxylabsCompletedScanJob } from "./oxylabsVerifyApply"
import { newOxylabsApplyOwner, runOwnedOxylabsApply } from "./oxylabsApplyOperations"
import { stripOxylabsSecrets } from "./oxylabsProductNormalize"
import { oxylabsCanaryUsage } from "./oxylabsPlanUsage"
import {
  OXYLABS_VERIFY_RESULT_JSON_LIMIT,
  oxylabsVerifyResultAuthBeforeBody,
} from "./oxylabsVerifyResultBody"

function oxylabsPlanStatusFields(canary: Awaited<ReturnType<typeof oxylabsCanaryUsage>>) {
  return {
    planMode: canary.planMode,
    monthlyLimit: canary.monthlyLimit,
    cycleStart: canary.cycleStart,
    cycleEnd: canary.cycleEnd,
    cycleReserved: canary.cycleReserved,
    cycleSuccessful: canary.cycleSuccessful,
    remaining: canary.remaining,
    lifetimeReserved: canary.lifetimeReserved,
    lifetimeSuccessful: canary.lifetimeSuccessful,
    pending: canary.pending,
    workerStatus: canary.workerStatus,
    lastProductAt: canary.lastProductAt,
    lastError: canary.lastError,
  }
}

function hasSessionCookie(req: Request): boolean {
  const name = sessionCookieName()
  const cookies = req.cookies as Record<string, unknown> | undefined
  return Boolean(cookies && typeof cookies[name] === "string" && String(cookies[name]).length > 0)
}

function applyOxylabsGate(req: Request, res: Response, route: "heartbeat" | "claim-next" | "result" | "fail"): boolean {
  const cfg = loadOxylabsVerifyConfig()
  const auth = authorizeOxylabsVerifyWorker(
    typeof req.headers.authorization === "string" ? req.headers.authorization : undefined
  )
  const authDecision = evaluateOxylabsBearerAuth({
    tokenConfigured: oxylabsVerifyWorkerAuthConfigured(),
    tokenOk: auth.ok === true,
    foreignToken: auth.ok === false && auth.foreign === true,
    hasSessionCookie: hasSessionCookie(req),
  })
  if (!("ok" in authDecision)) {
    res.status(authDecision.status).json({ ok: false, error: authDecision.error })
    return false
  }
  const body = (req.body ?? {}) as Record<string, unknown>
  const workerId = String(body.workerId ?? "").trim()
  if (!resolveOxylabsVerifyClaimKind(workerId)) {
    if (route === "claim-next") {
      res.status(200).json({ ok: true, job: null, message: "UNKNOWN_WORKER" })
      return false
    }
    res.status(400).json({ ok: false, error: "UNKNOWN_WORKER" })
    return false
  }
  const proto = evaluateOxylabsProtocolGate(cfg.protocolEnabled)
  if (!("ok" in proto)) {
    res.status(proto.status).json({ ok: false, error: proto.error })
    return false
  }
  if (oxylabsPricingForbidden()) {
    res.status(503).json({ ok: false, error: "OXYLABS_PRICING_FORBIDDEN" })
    return false
  }
  if (route === "claim-next" && !cfg.claimEnabled) {
    res.status(200).json({ ok: true, job: null, message: "OXYLABS_VERIFY_CLAIM_DISABLED" })
    return false
  }
  return true
}

export function registerOxylabsVerifyWorkerRoutes(app: { post: Function }): void {
  app.post("/internal/oxylabs-verify/heartbeat", async (req: Request, res: Response) => {
    if (!applyOxylabsGate(req, res, "heartbeat")) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const workerId = String(body.workerId ?? "").trim()
    const tel = sanitizeAmazonScanHostTelemetry(body.hostTelemetry)
    await upsertScanHeartbeat({
      workerId,
      status: String(body.status ?? "ONLINE"),
      browserRunning: false,
      currentJobId: body.currentJobId != null ? Number(body.currentJobId) : null,
      lastError: typeof body.lastError === "string" ? body.lastError : null,
      pauseReason: typeof body.pauseReason === "string" ? body.pauseReason : null,
      hostTelemetry: tel,
    })
    const canary = await oxylabsCanaryUsage()
    res.json({
      ok: true,
      canary: { reserved: canary.reserved, max: canary.max },
      ...oxylabsPlanStatusFields(canary),
    })
  })

  app.post("/internal/oxylabs-verify/claim-next", async (req: Request, res: Response) => {
    if (!applyOxylabsGate(req, res, "claim-next")) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const workerId = String(body.workerId ?? "").trim()
    const claimed = await claimNextOxylabsJob({ workerId, preferConfirm: body.preferConfirm === true })
    const canary = await oxylabsCanaryUsage()
    if (!claimed.job) {
      res.json({
        ok: true,
        job: null,
        message: claimed.message,
        canary: { reserved: canary.reserved, max: canary.max },
        ...oxylabsPlanStatusFields(canary),
      })
      return
    }
    const oxy = loadOxylabsVerifyConfig()
    res.json({
      ok: true,
      job: {
        jobId: claimed.job.id,
        asin: claimed.job.asin,
        kind: claimed.job.kind,
        leaseToken: claimed.leaseToken,
        expiredRecovery: claimed.expiredRecovery === true,
        keepaCandidateId: claimed.job.keepaCandidateId,
        source: oxy.source,
        geoLocation: oxy.geoLocation,
        parse: true,
      },
      canary: { reserved: canary.reserved, max: canary.max },
      ...oxylabsPlanStatusFields(canary),
    })
  })

  app.post(
    "/internal/oxylabs-verify/result",
    oxylabsVerifyResultAuthBeforeBody,
    express.json({ limit: OXYLABS_VERIFY_RESULT_JSON_LIMIT }),
    async (req: Request, res: Response) => {
    if (!applyOxylabsGate(req, res, "result")) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const workerId = String(body.workerId ?? "").trim()
    const jobId = Number(body.jobId)
    const leaseToken = String(body.leaseToken ?? "")
    if (!Number.isFinite(jobId) || !leaseToken) {
      res.status(400).json({ ok: false, error: "BAD_REQUEST" })
      return
    }
    if (String(body.source ?? "") === "amazon_pricing" || body.pricing === true) {
      res.status(400).json({ ok: false, error: "OXYLABS_PRICING_FORBIDDEN" })
      return
    }
    await markOxylabsJobRunning({ jobId, workerId, leaseToken }).catch(() => undefined)
    const observedAt = body.observedAt ? new Date(String(body.observedAt)) : new Date()
    const payload = stripOxylabsSecrets((body.payload && typeof body.payload === "object" ? body.payload : body) as Record<string, unknown>)
    const done = await completeOxylabsVerifyJob({
      jobId,
      workerId,
      leaseToken,
      payload,
      observedAt,
    })
    if (!done.ok) {
      res.status(409).json({ ok: false, error: done.code })
      return
    }
    if (!done.alreadyCompleted) {
      await runOwnedOxylabsApply(jobId, id =>
        applyOxylabsCompletedScanJob(id, { owner: newOxylabsApplyOwner("handler") })
      )
    }
    res.json({ ok: true, alreadyCompleted: done.alreadyCompleted === true })
  })

  app.post("/internal/oxylabs-verify/fail", async (req: Request, res: Response) => {
    if (!applyOxylabsGate(req, res, "fail")) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const workerId = String(body.workerId ?? "").trim()
    const jobId = Number(body.jobId)
    const leaseToken = String(body.leaseToken ?? "")
    if (!Number.isFinite(jobId) || !leaseToken) {
      res.status(400).json({ ok: false, error: "BAD_REQUEST" })
      return
    }
    const status = await failOxylabsVerifyJob({
      jobId,
      workerId,
      leaseToken,
      code: String(body.code ?? "WORKER_FAIL"),
      message: String(body.message ?? "fail").slice(0, 500),
    })
    res.json({ ok: true, status })
  })
}
