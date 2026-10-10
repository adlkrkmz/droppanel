/**
 * In-memory Amazon Supplier Reader job orchestration for ChatGPT App save_panel_draft.
 * No new tables/migrations — uses process memory + existing panel/extension bridge.
 */

import { createHash, randomUUID } from "crypto"
import { extractAmazonAsinFromUrl, normalizeSupplierUrl } from "../../amazon/supplierUrl"
import type { AmazonSupplierEvidence, AmazonSupplierReaderContext } from "../../amazon/supplierReaderTypes"

export const AMAZON_READER_HEARTBEAT_STALE_MS = 45_000
export const AMAZON_READER_JOB_TTL_MS = 5 * 60_000
export const AMAZON_READER_MCP_BOUNDED_WAIT_MS = 20_000
export const AMAZON_EXACT_URL_CACHE_TTL_MS = 30 * 60_000
export const AMAZON_DIRECT_PREFLIGHT_TIMEOUT_MS = 4_000

export type SupplierDraftJobStatus =
  | "queued"
  | "opening_supplier_page"
  | "reading_supplier_page"
  | "awaiting_user_verification"
  | "source_read_success"
  | "preparing_listing"
  | "saving_panel_draft"
  | "panel_draft_saved"
  | "panel_draft_updated"
  | "supplier_reader_unavailable"
  | "source_unavailable"
  | "expired"
  | "failed"

export type AmazonReaderSourceMode =
  | "browser_reader"
  | "exact_url_cache"
  | "direct_fetch"

export type AmazonSupplierReadJob = {
  jobId: string
  status: SupplierDraftJobStatus
  workspaceId: string
  shopId: string
  suppliedUrl: string
  normalizedUrl: string
  marketplace: "amazon"
  asin: string
  selectedVariationKey: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  browserTabOpened: boolean
  captchaEncountered: boolean
  userVerificationCompleted: boolean
  readerInstanceId: string | null
  sourceReadMode: AmazonReaderSourceMode | null
  sourceReadSucceeded: boolean
  toolInput: AmazonSupplierReaderContext | null
  readerPayload: AmazonReaderProductPayload | null
  resultPayloadHash: string | null
  draftId: string | null
  panelPath: string | null
  errorMessage: string | null
  databaseWritePerformed: boolean
  panelDraftSaved: boolean
}

export type AmazonReaderProductPayload = {
  title: string
  asin: string
  url: string
  finalUrl?: string
  priceAmount?: number | null
  priceCurrency?: string | null
  bullets?: string[]
  attributes?: Record<string, string>
  selectedVariation?: string | null
  images?: string[]
  extractedText?: string
  status: "FULL" | "PARTIAL"
  captchaEncountered?: boolean
  userVerificationCompleted?: boolean
  readerInstanceId?: string
}

type ReaderHeartbeat = {
  readerInstanceId: string
  lastHeartbeatAt: number
  capability: "amazon_product_page"
}

type ExactUrlCacheEntry = {
  asin: string
  normalizedUrl: string
  selectedVariationKey: string
  payload: AmazonReaderProductPayload
  savedAt: number
}

const readers = new Map<string, ReaderHeartbeat>()
const jobs = new Map<string, AmazonSupplierReadJob>()
const jobsByIdentity = new Map<string, string>()
const exactUrlCache = new Map<string, ExactUrlCacheEntry>()

let nowFn: () => number = () => Date.now()

/** Test-only clock injection. */
export function setAmazonReaderClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now())
}

/** Test-only reset. */
export function resetAmazonReaderStateForTests(): void {
  readers.clear()
  jobs.clear()
  jobsByIdentity.clear()
  exactUrlCache.clear()
  nowFn = () => Date.now()
}

export function isAmazonProductUrl(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase()
    return (
      host === "amazon.com" ||
      host.endsWith(".amazon.com") ||
      host.includes("amazon.")
    )
  } catch {
    return /amazon\.com/i.test(url)
  }
}

function identityKey(input: {
  workspaceId: string
  shopId: string
  normalizedUrl: string
  asin: string
  selectedVariationKey: string
}): string {
  return [
    input.workspaceId,
    input.shopId,
    "amazon",
    input.asin || input.normalizedUrl,
    input.selectedVariationKey || "none",
  ].join("|")
}

function cacheKey(input: {
  normalizedUrl: string
  asin: string
  selectedVariationKey: string
}): string {
  return [
    input.asin || input.normalizedUrl,
    input.selectedVariationKey || "none",
  ].join("|")
}

function hashPayload(payload: AmazonReaderProductPayload): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        asin: payload.asin,
        title: payload.title,
        url: payload.url,
        selectedVariation: payload.selectedVariation ?? null,
        bullets: payload.bullets ?? [],
        attributes: payload.attributes ?? {},
      })
    )
    .digest("hex")
}

export function getAmazonReaderAvailability(): {
  readerConnected: boolean
  readerLastHeartbeatAt?: string
  readerInstanceId?: string
  readerCapability?: "amazon_product_page"
} {
  pruneStaleReaders()
  const connected = [...readers.values()].sort(
    (a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt
  )[0]
  if (!connected) {
    return { readerConnected: false }
  }
  return {
    readerConnected: true,
    readerLastHeartbeatAt: new Date(connected.lastHeartbeatAt).toISOString(),
    readerInstanceId: connected.readerInstanceId,
    readerCapability: "amazon_product_page",
  }
}

export function recordAmazonReaderHeartbeat(input: {
  readerInstanceId: string
}): {
  readerConnected: boolean
  readerInstanceId: string
} {
  const id = String(input.readerInstanceId || "").trim() || randomUUID()
  readers.set(id, {
    readerInstanceId: id,
    lastHeartbeatAt: nowFn(),
    capability: "amazon_product_page",
  })
  return { readerConnected: true, readerInstanceId: id }
}

function pruneStaleReaders(): void {
  const cutoff = nowFn() - AMAZON_READER_HEARTBEAT_STALE_MS
  for (const [id, row] of readers) {
    if (row.lastHeartbeatAt < cutoff) readers.delete(id)
  }
}

function touchJob(job: AmazonSupplierReadJob, patch: Partial<AmazonSupplierReadJob>): AmazonSupplierReadJob {
  const next = {
    ...job,
    ...patch,
    updatedAt: nowFn(),
  }
  jobs.set(job.jobId, next)
  return next
}

export function expireStaleAmazonReaderJobs(now = nowFn()): number {
  let n = 0
  for (const job of jobs.values()) {
    if (
      job.expiresAt <= now &&
      job.status !== "panel_draft_saved" &&
      job.status !== "panel_draft_updated" &&
      job.status !== "expired" &&
      job.status !== "failed" &&
      job.status !== "source_unavailable" &&
      job.status !== "supplier_reader_unavailable"
    ) {
      touchJob(job, {
        status: "expired",
        errorMessage:
          "Amazon doğrulaması tamamlanmadığı için ürün okuma işi sona erdi ve panel taslağı oluşturulmadı.",
        databaseWritePerformed: false,
        panelDraftSaved: false,
      })
      jobsByIdentity.delete(
        identityKey({
          workspaceId: job.workspaceId,
          shopId: job.shopId,
          normalizedUrl: job.normalizedUrl,
          asin: job.asin,
          selectedVariationKey: job.selectedVariationKey,
        })
      )
      n += 1
    }
  }
  return n
}

export function getAmazonSupplierReadJob(
  jobId: string
): AmazonSupplierReadJob | null {
  expireStaleAmazonReaderJobs()
  return jobs.get(jobId) ?? null
}

export function findActiveAmazonSupplierReadJob(input: {
  workspaceId: string
  shopId: string
  supplierUrl: string
  selectedVariationKey?: string | null
}): AmazonSupplierReadJob | null {
  expireStaleAmazonReaderJobs()
  const normalizedUrl =
    normalizeSupplierUrl(input.supplierUrl) || input.supplierUrl.trim()
  const asin = extractAmazonAsinFromUrl(input.supplierUrl) || ""
  const selectedVariationKey =
    String(input.selectedVariationKey ?? "none").trim().toLowerCase() || "none"
  const key = identityKey({
    workspaceId: input.workspaceId,
    shopId: String(input.shopId),
    normalizedUrl,
    asin,
    selectedVariationKey,
  })
  const jobId = jobsByIdentity.get(key)
  if (!jobId) return null
  const job = jobs.get(jobId)
  if (!job) return null
  if (
    job.status === "expired" ||
    job.status === "failed" ||
    job.status === "panel_draft_saved" ||
    job.status === "panel_draft_updated" ||
    job.status === "source_unavailable" ||
    job.status === "supplier_reader_unavailable"
  ) {
    return null
  }
  return job
}

export function createOrAttachAmazonSupplierReadJob(input: {
  workspaceId: string
  shopId: string
  supplierUrl: string
  selectedVariationKey?: string | null
  toolInput?: AmazonSupplierReaderContext | null
}): AmazonSupplierReadJob {
  expireStaleAmazonReaderJobs()
  const existing = findActiveAmazonSupplierReadJob(input)
  if (existing) {
    if (input.toolInput) {
      return touchJob(existing, { toolInput: input.toolInput })
    }
    return existing
  }

  const normalizedUrl =
    normalizeSupplierUrl(input.supplierUrl) || input.supplierUrl.trim()
  const asin = extractAmazonAsinFromUrl(input.supplierUrl) || ""
  const selectedVariationKey =
    String(input.selectedVariationKey ?? "none").trim().toLowerCase() || "none"
  const now = nowFn()
  const job: AmazonSupplierReadJob = {
    jobId: randomUUID(),
    status: "queued",
    workspaceId: input.workspaceId,
    shopId: String(input.shopId),
    suppliedUrl: input.supplierUrl.trim(),
    normalizedUrl,
    marketplace: "amazon",
    asin,
    selectedVariationKey,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + AMAZON_READER_JOB_TTL_MS,
    browserTabOpened: false,
    captchaEncountered: false,
    userVerificationCompleted: false,
    readerInstanceId: null,
    sourceReadMode: null,
    sourceReadSucceeded: false,
    toolInput: input.toolInput ?? null,
    readerPayload: null,
    resultPayloadHash: null,
    draftId: null,
    panelPath: null,
    errorMessage: null,
    databaseWritePerformed: false,
    panelDraftSaved: false,
  }
  jobs.set(job.jobId, job)
  jobsByIdentity.set(
    identityKey({
      workspaceId: job.workspaceId,
      shopId: job.shopId,
      normalizedUrl: job.normalizedUrl,
      asin: job.asin,
      selectedVariationKey: job.selectedVariationKey,
    }),
    job.jobId
  )
  return job
}

export function claimNextAmazonSupplierReadJob(input: {
  readerInstanceId: string
}): AmazonSupplierReadJob | null {
  expireStaleAmazonReaderJobs()
  recordAmazonReaderHeartbeat({ readerInstanceId: input.readerInstanceId })
  const queued = [...jobs.values()]
    .filter((j) => j.status === "queued")
    .sort((a, b) => a.createdAt - b.createdAt)[0]
  if (!queued) return null
  return touchJob(queued, {
    status: "opening_supplier_page",
    readerInstanceId: input.readerInstanceId,
  })
}

export function updateAmazonSupplierReadJobStatus(
  jobId: string,
  patch: Partial<
    Pick<
      AmazonSupplierReadJob,
      | "status"
      | "browserTabOpened"
      | "captchaEncountered"
      | "userVerificationCompleted"
      | "errorMessage"
      | "draftId"
      | "panelPath"
      | "databaseWritePerformed"
      | "panelDraftSaved"
      | "sourceReadMode"
      | "sourceReadSucceeded"
    >
  >
): AmazonSupplierReadJob | null {
  const job = jobs.get(jobId)
  if (!job) return null
  if (job.status === "expired" || job.status === "failed") return job
  return touchJob(job, patch)
}

export function getExactUrlAmazonCache(input: {
  supplierUrl: string
  selectedVariationKey?: string | null
}): AmazonReaderProductPayload | null {
  const normalizedUrl =
    normalizeSupplierUrl(input.supplierUrl) || input.supplierUrl.trim()
  const asin = extractAmazonAsinFromUrl(input.supplierUrl) || ""
  const selectedVariationKey =
    String(input.selectedVariationKey ?? "none").trim().toLowerCase() || "none"
  const entry = exactUrlCache.get(
    cacheKey({ normalizedUrl, asin, selectedVariationKey })
  )
  if (!entry) return null
  if (nowFn() - entry.savedAt > AMAZON_EXACT_URL_CACHE_TTL_MS) {
    exactUrlCache.delete(cacheKey({ normalizedUrl, asin, selectedVariationKey }))
    return null
  }
  if (asin && entry.asin && entry.asin !== asin) return null
  if (!entry.payload.title?.trim()) return null
  if (/robot|captcha|human verification/i.test(entry.payload.title)) return null
  return entry.payload
}

export function putExactUrlAmazonCache(input: {
  supplierUrl: string
  selectedVariationKey?: string | null
  payload: AmazonReaderProductPayload
}): void {
  const normalizedUrl =
    normalizeSupplierUrl(input.supplierUrl) || input.supplierUrl.trim()
  const asin =
    extractAmazonAsinFromUrl(input.supplierUrl) ||
    input.payload.asin ||
    ""
  const selectedVariationKey =
    String(input.selectedVariationKey ?? "none").trim().toLowerCase() || "none"
  exactUrlCache.set(cacheKey({ normalizedUrl, asin, selectedVariationKey }), {
    asin,
    normalizedUrl,
    selectedVariationKey,
    payload: input.payload,
    savedAt: nowFn(),
  })
}

export function validateAmazonReaderPayload(input: {
  expectedUrl: string
  expectedAsin: string
  payload: AmazonReaderProductPayload
}): { ok: true } | { ok: false; reason: string } {
  const title = String(input.payload.title || "").trim()
  if (!title) return { ok: false, reason: "missing_title" }
  if (/robot|captcha|enter the characters|human verification/i.test(title)) {
    return { ok: false, reason: "captcha_html_as_payload" }
  }
  const payloadAsin = String(input.payload.asin || "")
    .trim()
    .toUpperCase()
  const expectedAsin = String(input.expectedAsin || "")
    .trim()
    .toUpperCase()
  if (expectedAsin && payloadAsin && payloadAsin !== expectedAsin) {
    return { ok: false, reason: "asin_mismatch" }
  }
  const url = String(input.payload.url || input.payload.finalUrl || "")
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (!host.includes("amazon.")) {
      return { ok: false, reason: "non_amazon_host" }
    }
  } catch {
    return { ok: false, reason: "invalid_url" }
  }
  const hasAttribute =
    Object.keys(input.payload.attributes || {}).length > 0 ||
    (input.payload.bullets || []).length > 0 ||
    Boolean(input.payload.extractedText?.trim())
  if (!hasAttribute && !payloadAsin) {
    return { ok: false, reason: "insufficient_product_evidence" }
  }
  // Images may be empty — not a failure.
  return { ok: true }
}

/**
 * Idempotent reader result submit. Same jobId+hash is a no-op after success.
 */
export function submitAmazonSupplierReadResult(input: {
  jobId: string
  readerInstanceId?: string
  payload: AmazonReaderProductPayload
  captchaEncountered?: boolean
  userVerificationCompleted?: boolean
}):
  | { ok: true; job: AmazonSupplierReadJob; duplicate: boolean }
  | { ok: false; code: string; message: string; job?: AmazonSupplierReadJob } {
  expireStaleAmazonReaderJobs()
  const job = jobs.get(input.jobId)
  if (!job) {
    return { ok: false, code: "JOB_NOT_FOUND", message: "Reader job not found." }
  }
  if (job.status === "expired") {
    return {
      ok: false,
      code: "JOB_EXPIRED",
      message: job.errorMessage || "Job expired.",
      job,
    }
  }
  if (
    job.status === "panel_draft_saved" ||
    job.status === "panel_draft_updated" ||
    job.status === "source_read_success" ||
    job.status === "preparing_listing" ||
    job.status === "saving_panel_draft"
  ) {
    return { ok: true, job, duplicate: true }
  }

  const validated = validateAmazonReaderPayload({
    expectedUrl: job.suppliedUrl,
    expectedAsin: job.asin,
    payload: input.payload,
  })
  if (!validated.ok) {
    return {
      ok: false,
      code: "INVALID_READER_PAYLOAD",
      message: validated.reason,
      job,
    }
  }

  const payloadHash = hashPayload(input.payload)
  if (job.resultPayloadHash && job.resultPayloadHash === payloadHash) {
    return { ok: true, job, duplicate: true }
  }

  putExactUrlAmazonCache({
    supplierUrl: job.suppliedUrl,
    selectedVariationKey: job.selectedVariationKey,
    payload: input.payload,
  })

  const next = touchJob(job, {
    status: "source_read_success",
    sourceReadSucceeded: true,
    sourceReadMode: "browser_reader",
    readerPayload: input.payload,
    resultPayloadHash: payloadHash,
    captchaEncountered:
      Boolean(input.captchaEncountered) || job.captchaEncountered,
    userVerificationCompleted:
      Boolean(input.userVerificationCompleted) ||
      job.userVerificationCompleted ||
      job.captchaEncountered,
    readerInstanceId:
      input.readerInstanceId?.trim() || job.readerInstanceId,
    browserTabOpened: true,
    expiresAt: nowFn() + AMAZON_READER_JOB_TTL_MS,
  })
  return { ok: true, job: next, duplicate: false }
}

export async function waitForAmazonSupplierReadJob(
  jobId: string,
  options?: {
    timeoutMs?: number
    pollMs?: number
    signal?: AbortSignal
  }
): Promise<AmazonSupplierReadJob | null> {
  const timeoutMs = options?.timeoutMs ?? AMAZON_READER_MCP_BOUNDED_WAIT_MS
  const pollMs = options?.pollMs ?? 500
  const started = nowFn()
  while (nowFn() - started < timeoutMs) {
    if (options?.signal?.aborted) break
    expireStaleAmazonReaderJobs()
    const job = jobs.get(jobId)
    if (!job) return null
    if (
      job.status === "source_read_success" ||
      job.status === "awaiting_user_verification" ||
      job.status === "panel_draft_saved" ||
      job.status === "panel_draft_updated" ||
      job.status === "supplier_reader_unavailable" ||
      job.status === "source_unavailable" ||
      job.status === "expired" ||
      job.status === "failed"
    ) {
      return job
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return jobs.get(jobId) ?? null
}

export async function shortAmazonDirectPreflight(
  url: string,
  deps?: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
  }
): Promise<AmazonReaderProductPayload | null> {
  const timeoutMs = deps?.timeoutMs ?? AMAZON_DIRECT_PREFLIGHT_TIMEOUT_MS
  const fetchImpl = deps?.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "text/html",
        "User-Agent":
          "Mozilla/5.0 (compatible; ListJetGo/1.0; +https://listjetgo.com)",
      },
      redirect: "follow",
    })
    if (!res.ok) return null
    const html = await res.text()
    if (
      /robot\s*check|enter the characters you see|human verification|automated access/i.test(
        html
      )
    ) {
      return null
    }
    const titleMatch =
      html.match(/id="productTitle"[^>]*>\s*([^<]+)/i) ||
      html.match(/<title>([^<]+)<\/title>/i)
    const title = String(titleMatch?.[1] || "")
      .replace(/\s*:\s*Amazon\..*$/i, "")
      .replace(/\s+/g, " ")
      .trim()
    if (!title || /robot|captcha/i.test(title)) return null
    const asin = extractAmazonAsinFromUrl(url) || ""
    if (!asin) return null
    return {
      title,
      asin,
      url,
      finalUrl: res.url || url,
      status: "PARTIAL",
      bullets: [],
      attributes: {},
      images: [],
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Amazon source-read order for save_panel_draft:
 * 1) browser reader job (primary)
 * 2) exact-URL/ASIN cache
 * 3) optional short direct preflight (once)
 * 4) unavailable
 */
export async function resolveAmazonSourceForSave(input: {
  workspaceId: string
  shopId: string
  supplierUrl: string
  selectedVariationKey?: string | null
  toolInput?: AmazonSupplierReaderContext | null
  boundedWaitMs?: number
  skipReaderWait?: boolean
  fetchImpl?: typeof fetch
}): Promise<{
  status:
    | "source_read_success"
    | "awaiting_user_verification"
    | "supplier_reader_unavailable"
    | "source_unavailable"
  job: AmazonSupplierReadJob | null
  payload: AmazonReaderProductPayload | null
  sourceReadMode: AmazonReaderSourceMode | null
  readerConnected: boolean
}> {
  const availability = getAmazonReaderAvailability()
  const cached = getExactUrlAmazonCache({
    supplierUrl: input.supplierUrl,
    selectedVariationKey: input.selectedVariationKey,
  })

  if (!availability.readerConnected) {
    if (cached) {
      return {
        status: "source_read_success",
        job: null,
        payload: cached,
        sourceReadMode: "exact_url_cache",
        readerConnected: false,
      }
    }
    const preflight = await shortAmazonDirectPreflight(input.supplierUrl, {
      fetchImpl: input.fetchImpl,
    })
    if (preflight) {
      putExactUrlAmazonCache({
        supplierUrl: input.supplierUrl,
        selectedVariationKey: input.selectedVariationKey,
        payload: preflight,
      })
      return {
        status: "source_read_success",
        job: null,
        payload: preflight,
        sourceReadMode: "direct_fetch",
        readerConnected: false,
      }
    }
    return {
      status: "supplier_reader_unavailable",
      job: null,
      payload: null,
      sourceReadMode: null,
      readerConnected: false,
    }
  }

  const job = createOrAttachAmazonSupplierReadJob({
    workspaceId: input.workspaceId,
    shopId: input.shopId,
    supplierUrl: input.supplierUrl,
    selectedVariationKey: input.selectedVariationKey,
    toolInput: input.toolInput,
  })

  if (input.skipReaderWait) {
    return {
      status: "awaiting_user_verification",
      job,
      payload: null,
      sourceReadMode: null,
      readerConnected: true,
    }
  }

  const waited = await waitForAmazonSupplierReadJob(job.jobId, {
    timeoutMs: input.boundedWaitMs ?? AMAZON_READER_MCP_BOUNDED_WAIT_MS,
  })
  const current = waited ?? getAmazonSupplierReadJob(job.jobId)

  if (current?.status === "source_read_success" && current.readerPayload) {
    return {
      status: "source_read_success",
      job: current,
      payload: current.readerPayload,
      sourceReadMode: "browser_reader",
      readerConnected: true,
    }
  }
  if (current?.status === "awaiting_user_verification") {
    return {
      status: "awaiting_user_verification",
      job: current,
      payload: null,
      sourceReadMode: null,
      readerConnected: true,
    }
  }
  if (
    current?.status === "opening_supplier_page" ||
    current?.status === "reading_supplier_page" ||
    current?.status === "queued"
  ) {
    // Still opening — treat as awaiting verification / in-progress for UX (no second command).
    const marked = updateAmazonSupplierReadJobStatus(job.jobId, {
      status: "awaiting_user_verification",
      browserTabOpened: current.browserTabOpened,
    })
    return {
      status: "awaiting_user_verification",
      job: marked ?? current,
      payload: null,
      sourceReadMode: null,
      readerConnected: true,
    }
  }

  if (cached) {
    return {
      status: "source_read_success",
      job: current,
      payload: cached,
      sourceReadMode: "exact_url_cache",
      readerConnected: true,
    }
  }

  const preflight = await shortAmazonDirectPreflight(input.supplierUrl, {
    fetchImpl: input.fetchImpl,
  })
  if (preflight) {
    putExactUrlAmazonCache({
      supplierUrl: input.supplierUrl,
      selectedVariationKey: input.selectedVariationKey,
      payload: preflight,
    })
    return {
      status: "source_read_success",
      job: current,
      payload: preflight,
      sourceReadMode: "direct_fetch",
      readerConnected: true,
    }
  }

  return {
    status: "source_unavailable",
    job: current,
    payload: null,
    sourceReadMode: null,
    readerConnected: true,
  }
}

export function buildAmazonReaderEvidenceFields(
  payload: AmazonReaderProductPayload
): AmazonSupplierEvidence {
  return {
    title: payload.title,
    imageUrls: (payload.images || []).slice(0, 20),
    price:
      payload.priceAmount != null
        ? {
            amount: payload.priceAmount,
            currency: payload.priceCurrency || "USD",
          }
        : undefined,
    selectedVariation: payload.selectedVariation || undefined,
    bulletPoints: payload.bullets || [],
    specifications: Object.entries(payload.attributes || {}).map(
      ([k, v]) => `${k}: ${v}`
    ),
  }
}
