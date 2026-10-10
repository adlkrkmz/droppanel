import assert from "assert"
import fs from "fs"
import path from "path"
import http from "http"
import express from "express"
import cookieParser from "cookie-parser"
import { createRateLimiter, resetRateLimitBucketsForTests } from "../modules/security/httpSecurity"
import {
  OXYLABS_VERIFY_RESULT_JSON_LIMIT,
  OXYLABS_VERIFY_RESULT_PATH,
  isOxylabsVerifyResultPost,
  oxylabsJsonParseErrorHandler,
  oxylabsVerifyResultAuthBeforeBody,
  skipDefaultJsonForOxylabsResult,
} from "../modules/oxylabsVerify/oxylabsVerifyResultBody"

process.env.OXYLABS_VERIFY_WORKER_TOKEN = "o".repeat(32)
process.env.AMAZON_SCAN_WORKER_TOKEN = "s".repeat(32)
process.env.KEEPA_COLLECTOR_WORKER_TOKEN = "k".repeat(32)

const oxyTok = "o".repeat(32)
const scanTok = "s".repeat(32)

function padJson(targetBytes: number): string {
  const base = {
    workerId: "oxylabs-product-primary-A",
    jobId: 1,
    leaseToken: "lease-fixture",
    source: "amazon_product",
    payload: { results: [{ content: { asin: "B00TEST001", price: 1.23, stock: "In Stock" }, status_code: 200 }] },
    pad: "",
  }
  let raw = JSON.stringify(base)
  const need = targetBytes - Buffer.byteLength(raw, "utf8")
  if (need > 0) {
    base.pad = "x".repeat(need)
    raw = JSON.stringify(base)
  }
  while (Buffer.byteLength(raw, "utf8") < targetBytes) {
    base.pad += "x"
    raw = JSON.stringify(base)
  }
  return raw
}

function buildFixtureApp(onResult: () => void, onOtherOxy: (route: string) => void) {
  const app = express()
  app.use(cookieParser())
  app.use(skipDefaultJsonForOxylabsResult(express.json()))
  resetRateLimitBucketsForTests()
  app.use(
    "/internal/oxylabs-verify",
    createRateLimiter({
      name: "oxylabs-verify-worker",
      windowMs: 60_000,
      max: 180,
    })
  )
  app.post(
    OXYLABS_VERIFY_RESULT_PATH,
    oxylabsVerifyResultAuthBeforeBody,
    express.json({ limit: OXYLABS_VERIFY_RESULT_JSON_LIMIT }),
    (req, res) => {
      onResult()
      res.json({ ok: true, reached: true, bytes: Buffer.byteLength(JSON.stringify(req.body), "utf8") })
    }
  )
  app.post("/internal/oxylabs-verify/heartbeat", (req, res) => {
    onOtherOxy("heartbeat")
    res.json({ ok: true, route: "heartbeat", hasBody: Boolean(req.body && Object.keys(req.body).length) })
  })
  app.post("/internal/oxylabs-verify/claim-next", (req, res) => {
    onOtherOxy("claim-next")
    res.json({ ok: true, route: "claim-next" })
  })
  app.post("/internal/oxylabs-verify/fail", (req, res) => {
    onOtherOxy("fail")
    res.json({ ok: true, route: "fail" })
  })
  app.post("/health", (_req, res) => res.json({ status: "ok" }))
  app.post("/public/echo", (req, res) => res.json({ ok: true, echo: req.body }))
  app.use(oxylabsJsonParseErrorHandler)
  app.use((err: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: "INTERNAL_ERROR" })
  })
  return app
}

async function post(
  server: http.Server,
  pathName: string,
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("no addr")
  const res = await fetch(`http://127.0.0.1:${addr.port}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json }
}

void (async function main() {
assert.equal(isOxylabsVerifyResultPost({ method: "POST", path: "/internal/oxylabs-verify/result" }), true)
assert.equal(isOxylabsVerifyResultPost({ method: "POST", path: "/internal/oxylabs-verify/fail" }), false)
assert.equal(isOxylabsVerifyResultPost({ method: "GET", path: "/internal/oxylabs-verify/result" }), false)
assert.equal(OXYLABS_VERIFY_RESULT_JSON_LIMIT, "512kb")

const sized = padJson(117626)
assert.equal(Buffer.byteLength(sized, "utf8"), 117626)

let resultHits = 0
let otherHits = 0
const app = buildFixtureApp(
  () => {
    resultHits += 1
  },
  () => {
    otherHits += 1
  }
)
const server = http.createServer(app)
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))

{
  const r = await post(server, "/internal/oxylabs-verify/result", sized, { authorization: `Bearer ${oxyTok}` })
  assert.equal(r.status, 200)
  assert.equal(r.json.reached, true)
  assert.equal(resultHits, 1)
  console.log("PASS 1 valid token 117626 reaches handler")
}

{
  const before = resultHits
  const r = await post(server, "/internal/oxylabs-verify/result", sized, { authorization: `Bearer ${"x".repeat(32)}` })
  assert.equal(r.status, 401)
  assert.equal(resultHits, before)
  console.log("PASS 2 wrong token 117626 → 401, handler skipped")
}

{
  const before = resultHits
  const r = await post(server, "/internal/oxylabs-verify/result", sized, {})
  assert.equal(r.status, 401)
  assert.equal(resultHits, before)
  console.log("PASS 3 missing token 117626 → 401")
}

{
  const before = resultHits
  const huge = padJson(512 * 1024 + 64)
  assert.ok(Buffer.byteLength(huge, "utf8") > 512 * 1024)
  const r = await post(server, "/internal/oxylabs-verify/result", huge, { authorization: `Bearer ${oxyTok}` })
  assert.equal(r.status, 413)
  assert.equal(resultHits, before)
  console.log("PASS 4 over 512kb valid token → 413")
}

{
  const before = resultHits
  const r = await post(server, "/internal/oxylabs-verify/result", "{not-json", {
    authorization: `Bearer ${oxyTok}`,
  })
  assert.equal(r.status, 400)
  assert.equal(resultHits, before)
  console.log("PASS 5 broken JSON → 400")
}

{
  const r = await post(server, "/public/echo", sized, {})
  assert.equal(r.status, 413)
  console.log("PASS 6 public 117626 → 413 (100kb global)")
}

{
  const small = JSON.stringify({ workerId: "oxylabs-product-primary-A", ping: true })
  const hb = await post(server, "/internal/oxylabs-verify/heartbeat", small, { authorization: `Bearer ${oxyTok}` })
  assert.equal(hb.status, 200)
  const bigHb = await post(server, "/internal/oxylabs-verify/fail", sized, { authorization: `Bearer ${oxyTok}` })
  assert.equal(bigHb.status, 413)
  assert.equal(otherHits, 1)
  console.log("PASS 7 heartbeat/fail keep 100kb; bucket name unchanged")
}

{
  const before = resultHits
  const r = await post(server, "/internal/oxylabs-verify/result", sized, { authorization: `Bearer ${scanTok}` })
  assert.equal(r.status, 401)
  assert.equal(resultHits, before)
  console.log("PASS 8 amazon-scan token → 401")
}

const handlerSrc = fs.readFileSync(path.join(__dirname, "../modules/oxylabsVerify/oxylabsVerifyHandlers.ts"), "utf8")
assert.match(handlerSrc, /if \(!done\.alreadyCompleted\)/)
assert.match(handlerSrc, /oxylabsVerifyResultAuthBeforeBody/)
assert.match(handlerSrc, /limit: OXYLABS_VERIFY_RESULT_JSON_LIMIT/)
assert.doesNotMatch(handlerSrc, /jobId === 8375/)
console.log("PASS 9 result replay still skips second apply; no job 8375")

const httpSrc = fs.readFileSync(path.join(__dirname, "../modules/http/httpServer.ts"), "utf8")
assert.match(httpSrc, /skipDefaultJsonForOxylabsResult\(express\.json\(\)\)/)
assert.match(httpSrc, /name: "oxylabs-verify-worker"/)
assert.match(httpSrc, /app\.use\("\/internal\/oxylabs-verify", oxylabsVerifyWorkerLimiter\)/)
console.log("PASS 10 skip default json only for result; other oxylabs limiter unchanged")

await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
console.log("PASS oxylabs-result-json-limit fixtures")
})().catch(e => {
  console.error(e)
  process.exit(1)
})
