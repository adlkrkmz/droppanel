import { createHash } from "crypto"
import { mapPublicObservationToVerificationPayload } from "../amazonPublicWorker/mapPublicObservationToVerificationPayload"
import {
  selectOfferObservation,
  type AccordionOfferRaw,
} from "../amazonPublicWorker/alternateOfferSelect"
import type { AmazonObservation, AmazonOfferCondition } from "../amazonPublicWorker/parsing"
import { shipsFromAmazon } from "../amazonVerification/amazonVerificationNormalize"
import { classifyVerifiedAmazonSource } from "../amazonVerification/verifiedSourceDecision"
import { bumpDesktopAgentObservationStats } from "./desktopAgentAuth"
import { advanceCloudCheckAfterDesktopSuccess } from "./desktopAgentCadence"
import {
  claimOrCreateDesktopVerificationTask,
  failDesktopVerificationTask,
  logDesktopObservationEvent,
  submitDesktopVerificationResult,
} from "./desktopAgentClaim"
import { findDesktopAgentListingForAsin } from "./desktopAgentAsins"
import type { DesktopAgentDeviceRow, DesktopObservationBody } from "./desktopAgentTypes"
import { isTechnicalStatusProbe } from "./desktopAgentObservationProbe"

const FORBIDDEN_CLIENT_DECISION_KEYS = [
  "stockGuardDecision",
  "stockGuard",
  "qtyMutation",
  "priceMutation",
  "ebayQuantity",
  "ebayPrice",
  "decision",
  "finalAction",
  "applyQty",
  "applyPrice",
]

const MAX_DESKTOP_FUTURE_SKEW_MS = 5 * 60_000

function parseDesktopCheckedAt(raw: unknown, receivedAt: Date): {
  value: Date
  source: "CLIENT" | "SERVER_RECEIPT_FALLBACK"
} {
  if (raw == null || String(raw).trim() === "") {
    return { value: receivedAt, source: "SERVER_RECEIPT_FALLBACK" }
  }
  const value = new Date(String(raw))
  if (Number.isNaN(value.getTime())) {
    throw Object.assign(new Error("checkedAt must be a valid timestamp"), {
      status: 400,
      code: "INVALID_CHECKED_AT",
    })
  }
  if (value.getTime() > receivedAt.getTime() + MAX_DESKTOP_FUTURE_SKEW_MS) {
    throw Object.assign(new Error("checkedAt is too far in the future"), {
      status: 400,
      code: "CHECKED_AT_CLOCK_SKEW",
    })
  }
  return { value, source: "CLIENT" }
}

function desktopObservationFingerprint(body: Record<string, unknown>, checkedAt: Date, hasClientCheckedAt: boolean): string {
  const evidence = {
    asin: String(body.requestedAsin ?? "").trim().toUpperCase(),
    actualAsin: body.actualAsin ?? null,
    status: body.status ?? body.publicStatus ?? null,
    offerCondition: body.offerCondition ?? null,
    price: body.price ?? null,
    prime: body.prime ?? null,
    shipsFrom: body.shipsFrom ?? null,
    soldBy: body.soldBy ?? null,
    availability: body.availability ?? null,
    inStock: body.inStock ?? null,
    newOfferAvailable: body.newOfferAvailable ?? null,
    productNotFound: body.productNotFound ?? null,
    pageExists: body.pageExists ?? null,
    offerLabel: body.offerLabel ?? null,
    finalUrl: body.finalUrl ?? null,
    alternateOffer: body.alternateOffer ?? null,
    accordionOffers: body.accordionOffers ?? null,
    checkedAt: hasClientCheckedAt ? checkedAt.toISOString() : null,
  }
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex")
}

function isTechnicalStatus(status: string | null | undefined, code?: string | null): boolean {
  return isTechnicalStatusProbe(status) || isTechnicalStatusProbe(code)
}

function normalizeCondition(raw: unknown): AmazonOfferCondition {
  const s = String(raw ?? "").trim().toUpperCase()
  if (s === "NEW") return "NEW"
  if (s === "USED") return "USED"
  if (s === "LIKE_NEW" || s === "LIKE-NEW") return "LIKE_NEW"
  if (s === "RENEWED") return "RENEWED"
  if (s === "RESALE") return "RESALE"
  return "UNKNOWN"
}

function toObservation(body: DesktopObservationBody, requestedAsin: string): AmazonObservation {
  const price =
    typeof body.price === "number" && Number.isFinite(body.price) && body.price > 0 ? body.price : null
  return {
    actualAsin: body.actualAsin?.trim().toUpperCase() || null,
    pageExists: body.pageExists !== false && body.productNotFound !== true,
    mainPrice: price,
    primeMemberPrice: null,
    regularPrice: null,
    primeVisible: typeof body.prime === "boolean" ? body.prime : null,
    shipsFrom: body.shipsFrom ?? null,
    soldBy: body.soldBy ?? null,
    availability: body.availability ?? null,
    inStock: typeof body.inStock === "boolean" ? body.inStock : null,
    offerLabel: body.offerLabel ?? null,
    offerCondition: normalizeCondition(body.offerCondition),
    newOfferAvailable:
      typeof body.newOfferAvailable === "boolean" ? body.newOfferAvailable : null,
    finalUrl:
      typeof body.finalUrl === "string" && body.finalUrl.trim()
        ? body.finalUrl.trim()
        : `https://www.amazon.com/dp/${encodeURIComponent(requestedAsin)}`,
  }
}

function parseAccordionOffers(raw: unknown): AccordionOfferRaw[] {
  if (!Array.isArray(raw)) return []
  const out: AccordionOfferRaw[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    out.push({
      id: String(o.id ?? out.length),
      buyingType: o.buyingType != null ? String(o.buyingType) : null,
      caption: o.caption != null ? String(o.caption) : null,
      priceText: o.priceText != null ? String(o.priceText) : null,
      shipsFrom: o.shipsFrom != null ? String(o.shipsFrom) : null,
      soldBy: o.soldBy != null ? String(o.soldBy) : null,
      availability: o.availability != null ? String(o.availability) : null,
      primeEvidence: o.primeEvidence != null ? String(o.primeEvidence) : null,
      primeIcon: o.primeIcon === true,
      rowText: String(o.rowText ?? ""),
    })
  }
  return out
}

function rejectClientStockGuardDecisions(body: Record<string, unknown>): string | null {
  for (const key of FORBIDDEN_CLIENT_DECISION_KEYS) {
    if (key in body && body[key] != null) {
      return `Client Stock Guard decision field rejected: ${key}`
    }
  }
  return null
}

export async function handleDesktopObservation(input: {
  device: DesktopAgentDeviceRow
  body: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  const forbidden = rejectClientStockGuardDecisions(input.body)
  if (forbidden) {
    await logDesktopObservationEvent({
      device: input.device,
      asin: String(input.body.requestedAsin ?? "").toUpperCase() || "UNKNOWN",
      eventKind: "REJECTED",
      errorCode: "CLIENT_DECISION_FORBIDDEN",
    })
    throw Object.assign(new Error(forbidden), { status: 400, code: "CLIENT_DECISION_FORBIDDEN" })
  }

  const body = input.body as unknown as DesktopObservationBody
  const requestedAsin = String(body.requestedAsin ?? "").trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(requestedAsin)) {
    throw Object.assign(new Error("requestedAsin is required"), { status: 400 })
  }
  if (body.deviceId && body.deviceId !== input.device.deviceId) {
    throw Object.assign(new Error("deviceId mismatch"), { status: 403 })
  }
  const receivedAt = new Date()
  const checkedAtResult = parseDesktopCheckedAt(body.checkedAt, receivedAt)
  const observationId =
    typeof body.observationId === "string" && body.observationId.trim()
      ? body.observationId.trim().slice(0, 200)
      : null
  const observationFingerprint = desktopObservationFingerprint(
    input.body,
    checkedAtResult.value,
    body.checkedAt != null && String(body.checkedAt).trim() !== ""
  )

  const listing = await findDesktopAgentListingForAsin({
    workspaceId: input.device.workspaceId,
    asin: requestedAsin,
  })
  if (!listing) {
    throw Object.assign(new Error("ASIN not in this workspace"), { status: 404, code: "ASIN_NOT_IN_WORKSPACE" })
  }

  const publicStatus = String(
    (input.body.status as string | undefined) ??
      (input.body.publicStatus as string | undefined) ??
      "AMAZON_CHECKED"
  ).trim().toUpperCase()

  const claim = await claimOrCreateDesktopVerificationTask({
    device: input.device,
    asin: requestedAsin,
    checkedAt: checkedAtResult.value,
    observationId,
    observationFingerprint,
  })
  if (!claim.ok) {
    if (claim.code === "DUPLICATE_OBSERVATION" || claim.code === "STALE_OBSERVATION") {
      await logDesktopObservationEvent({
        device: input.device,
        asin: requestedAsin,
        eventKind: "REJECTED",
        errorCode: claim.code,
      })
      return {
        ok: true,
        kind: claim.code === "DUPLICATE_OBSERVATION" ? "DUPLICATE" : "STALE",
        publicStatus,
        cloudCheckAdvanced: false,
        stockGuardMutated: false,
      }
    }
    const status = claim.code === "TASK_BUSY" ? 409 : claim.code === "NO_LISTING" ? 404 : 409
    throw Object.assign(new Error(claim.message), {
      status,
      code: claim.code,
      ...(claim.code === "TASK_DEFERRED" ? { deferUntil: claim.deferUntil } : {}),
    })
  }

  if (isTechnicalStatus(publicStatus)) {
    await failDesktopVerificationTask({
      device: input.device,
      task: claim.task,
      code: publicStatus.slice(0, 80) || "TECHNICAL",
      message: `Desktop technical failure: ${publicStatus}`,
    })
    await bumpDesktopAgentObservationStats({
      deviceId: input.device.deviceId,
      workspaceId: input.device.workspaceId,
      kind: "TECHNICAL_FAILURE",
    })
    await logDesktopObservationEvent({
      device: input.device,
      asin: requestedAsin,
      catalogStateId: claim.task.catalogStateId,
      taskId: claim.task.id,
      eventKind: "TECHNICAL_FAILURE",
      publicStatus,
      errorCode: publicStatus,
    })
    return {
      ok: true,
      kind: "TECHNICAL_FAILURE",
      taskId: claim.task.id,
      publicStatus,
      cloudCheckAdvanced: false,
      stockGuardMutated: false,
    }
  }

  let observation = toObservation(body, requestedAsin)
  let statusForMap = publicStatus
  const accordionOffers = parseAccordionOffers(input.body.accordionOffers)
  if (accordionOffers.length > 0) {
    const selection = selectOfferObservation({
      primary: observation,
      accordionOffers,
    })
    observation = selection.observation
    if (selection.finalSelectedSource === "ALTERNATE" && selection.publicStatusHint) {
      statusForMap = selection.publicStatusHint
    }
  } else if (body.alternateOffer && typeof body.alternateOffer === "object") {
    // Client already selected alternate — trust provided primary observation fields.
  }

  const mapped = mapPublicObservationToVerificationPayload({
    requestedAsin,
    observation,
    publicStatus: statusForMap,
  })
  mapped.payload.metadata = {
    ...(mapped.payload.metadata ?? {}),
    verificationSource: "DESKTOP_AGENT",
    deviceId: input.device.deviceId,
    checkedAt: checkedAtResult.value.toISOString(),
    checkedAtSource: checkedAtResult.source,
    desktopObservationId: observationId,
    desktopObservationFingerprint: observationFingerprint,
  }

  if (statusForMap === "AMAZON_INCOMPLETE" || mapped.mappedCodeHint === "INCOMPLETE") {
    await failDesktopVerificationTask({
      device: input.device,
      task: claim.task,
      code: "AMAZON_INCOMPLETE",
      message: "Desktop observation incomplete — non-destructive",
    })
    await bumpDesktopAgentObservationStats({
      deviceId: input.device.deviceId,
      workspaceId: input.device.workspaceId,
      kind: "TECHNICAL_FAILURE",
    })
    await logDesktopObservationEvent({
      device: input.device,
      asin: requestedAsin,
      catalogStateId: claim.task.catalogStateId,
      taskId: claim.task.id,
      eventKind: "TECHNICAL_FAILURE",
      publicStatus: statusForMap,
      errorCode: "AMAZON_INCOMPLETE",
    })
    return {
      ok: true,
      kind: "TECHNICAL_FAILURE",
      taskId: claim.task.id,
      publicStatus: statusForMap,
      cloudCheckAdvanced: false,
      stockGuardMutated: false,
    }
  }

  const submitted = await submitDesktopVerificationResult({
    device: input.device,
    task: claim.task,
    payload: mapped.payload,
  })

  const decision = classifyVerifiedAmazonSource({
    requestedAsin,
    finalAsin: mapped.payload.finalAsin,
    displayedPrice: typeof mapped.payload.displayedPrice === "number" ? mapped.payload.displayedPrice : null,
    condition: typeof mapped.payload.condition === "string" ? mapped.payload.condition : null,
    isPrime: typeof mapped.payload.isPrime === "boolean" ? mapped.payload.isPrime : null,
    isFba: typeof mapped.payload.isFba === "boolean" ? mapped.payload.isFba : null,
    shipsFromAmazon: shipsFromAmazon(mapped.shipsFromNormalized),
    stockStatus: typeof mapped.payload.stockStatus === "string" ? mapped.payload.stockStatus : null,
    availabilityText:
      typeof mapped.payload.availabilityText === "string" ? mapped.payload.availabilityText : null,
    pageUnavailable: mapped.payload.pageUnavailable === true,
    redirected: mapped.payload.redirected === true,
    offerPageHealthy: mapped.payload.metadata?.offerPageHealthy === true,
  })

  const cadence = submitted.alreadyCompleted || decision.outcome === "UNKNOWN"
    ? null
    : await advanceCloudCheckAfterDesktopSuccess({
        globalAsinId: claim.task.globalAsinId,
        catalogStateId: claim.task.catalogStateId,
        priority: listing.priority,
        checkedAt: checkedAtResult.value,
      })

  await bumpDesktopAgentObservationStats({
    deviceId: input.device.deviceId,
    workspaceId: input.device.workspaceId,
    kind: "SUCCESS",
  })
  await logDesktopObservationEvent({
    device: input.device,
    asin: requestedAsin,
    catalogStateId: claim.task.catalogStateId,
    taskId: claim.task.id,
    eventKind: "SUCCESS",
    publicStatus: statusForMap,
    decisionCode: decision.code,
  })

  return {
    ok: true,
    kind: "SUCCESS",
    taskId: claim.task.id,
    createdTask: claim.created,
    alreadyCompleted: submitted.alreadyCompleted === true,
    publicStatus: statusForMap,
    decision: { outcome: decision.outcome, code: decision.code },
    cloudCheckAdvanced: cadence != null,
    nextCheckAt: cadence?.nextCheckAt ?? null,
    cadenceHours: cadence?.cadenceHours ?? null,
    trustedNewAmazonOffer: submitted.trustedNewAmazonOffer,
  }
}

export async function handleDesktopFailure(input: {
  device: DesktopAgentDeviceRow
  body: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  const requestedAsin = String(input.body.requestedAsin ?? input.body.asin ?? "")
    .trim()
    .toUpperCase()
  const code = String(input.body.code ?? input.body.status ?? "TECHNICAL")
    .trim()
    .toUpperCase()
    .slice(0, 80)
  const message = String(input.body.message ?? `Desktop technical failure: ${code}`).slice(0, 400)

  if (!/^[A-Z0-9]{10}$/.test(requestedAsin)) {
    throw Object.assign(new Error("requestedAsin is required"), { status: 400 })
  }

  const claim = await claimOrCreateDesktopVerificationTask({
    device: input.device,
    asin: requestedAsin,
  })
  if (!claim.ok) {
    // Still record failure for observability even if no claim (e.g. busy).
    await bumpDesktopAgentObservationStats({
      deviceId: input.device.deviceId,
      workspaceId: input.device.workspaceId,
      kind: "TECHNICAL_FAILURE",
    })
    await logDesktopObservationEvent({
      device: input.device,
      asin: requestedAsin,
      eventKind: "TECHNICAL_FAILURE",
      errorCode: code,
      publicStatus: code,
    })
    if (claim.code === "TASK_BUSY") {
      return {
        ok: true,
        kind: "TECHNICAL_FAILURE",
        cloudCheckAdvanced: false,
        stockGuardMutated: false,
        note: "task_busy_recorded_only",
      }
    }
    throw Object.assign(new Error(claim.message), {
      status: claim.code === "NO_LISTING" ? 404 : 409,
      code: claim.code,
    })
  }

  await failDesktopVerificationTask({
    device: input.device,
    task: claim.task,
    code: code || "TECHNICAL",
    message,
  })
  await bumpDesktopAgentObservationStats({
    deviceId: input.device.deviceId,
    workspaceId: input.device.workspaceId,
    kind: "TECHNICAL_FAILURE",
  })
  await logDesktopObservationEvent({
    device: input.device,
    asin: requestedAsin,
    catalogStateId: claim.task.catalogStateId,
    taskId: claim.task.id,
    eventKind: "TECHNICAL_FAILURE",
    publicStatus: code,
    errorCode: code,
  })

  return {
    ok: true,
    kind: "TECHNICAL_FAILURE",
    taskId: claim.task.id,
    cloudCheckAdvanced: false,
    stockGuardMutated: false,
  }
}
