import assert from "assert"
import fs from "fs"
import path from "path"
import {
  createRateLimiter,
  hashedAuthorizationSubject,
  internalScraperRateLimitKey,
  isInternalScraperApiPath,
  resetRateLimitBucketsForTests,
} from "../modules/security/httpSecurity"

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    method: "POST",
    headers: {},
    cookies: {},
    body: {},
    ip: "203.0.113.9",
    socket: { remoteAddress: "203.0.113.9" },
    path: "/internal/keepa-collector/observations",
    ...overrides,
  }
}
function mockRes(): any {
  return {
    code: 200,
    body: null,
    headers: {} as Record<string, string>,
    status(n: number) {
      this.code = n
      return this
    },
    json(v: unknown) {
      this.body = v
      return this
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v
    },
  }
}

assert.equal(isInternalScraperApiPath("/internal/keepa-collector/observations"), true)
assert.equal(isInternalScraperApiPath("/internal/keepa-collector/heartbeat"), true)
assert.equal(isInternalScraperApiPath("/internal/amazon-scan/heartbeat"), true)
assert.equal(isInternalScraperApiPath("/internal/amazon-scan/claim-next"), true)
assert.equal(isInternalScraperApiPath("/internal/amazon-scan/result"), true)
assert.equal(isInternalScraperApiPath("/internal/amazon-scan/fail"), true)
assert.equal(isInternalScraperApiPath("/internal/oxylabs-verify/heartbeat"), true)
assert.equal(isInternalScraperApiPath("/internal/oxylabs-verify/claim-next"), true)
assert.equal(isInternalScraperApiPath("/internal/oxylabs-verify/result"), true)
assert.equal(isInternalScraperApiPath("/internal/oxylabs-verify/fail"), true)
assert.equal(isInternalScraperApiPath("/health"), false)
assert.equal(isInternalScraperApiPath("/auth/login"), false)
assert.equal(isInternalScraperApiPath("/admin/platform/amazon-worker"), false)

const collectorTok = `Bearer ${"c".repeat(32)}`
const scanTok = `Bearer ${"s".repeat(32)}`
const ip = "203.0.113.9"
assert.notEqual(hashedAuthorizationSubject(collectorTok, ip), collectorTok)
assert.notEqual(hashedAuthorizationSubject(collectorTok, ip), "c".repeat(32))
assert.equal(hashedAuthorizationSubject(collectorTok, ip).length, 64)
assert.notEqual(hashedAuthorizationSubject(collectorTok, ip), hashedAuthorizationSubject(scanTok, ip))

resetRateLimitBucketsForTests()
const general = createRateLimiter({ name: "general", windowMs: 60_000, max: 2 })
const obs = createRateLimiter({
  name: "keepa-collector-observations",
  windowMs: 60_000,
  max: 5,
  keyFn: req => internalScraperRateLimitKey(req),
})
const scan = createRateLimiter({
  name: "amazon-scan-worker",
  windowMs: 60_000,
  max: 3,
  keyFn: req => internalScraperRateLimitKey(req, String(req.body?.workerId ?? "")),
})

const collectorReq = () => mockReq({ headers: { authorization: collectorTok }, body: {} })
const aReq = () =>
  mockReq({
    headers: { authorization: scanTok },
    body: { workerId: "amazon-keepa-verify-primary-A" },
    path: "/internal/amazon-scan/heartbeat",
  })
const cReq = () =>
  mockReq({
    headers: { authorization: scanTok },
    body: { workerId: "amazon-keepa-verify-confirm-C" },
    path: "/internal/amazon-scan/result",
  })

for (let i = 0; i < 5; i++) {
  const res = mockRes()
  let next = 0
  obs(collectorReq(), res, () => {
    next++
  })
  assert.equal(res.code, 200)
  assert.equal(next, 1)
}
{
  const res = mockRes()
  let next = 0
  obs(collectorReq(), res, () => {
    next++
  })
  assert.equal(res.code, 429)
  assert.equal(next, 0)
  assert.ok(res.headers["Retry-After"])
  assert.equal((res.body as { error: string }).error, "RATE_LIMITED")
}

for (let i = 0; i < 3; i++) {
  const res = mockRes()
  let next = 0
  scan(aReq(), res, () => {
    next++
  })
  assert.equal(next, 1, "A heartbeat/result still allowed during collector burst")
  assert.equal(res.code, 200)
}
for (let i = 0; i < 2; i++) {
  const res = mockRes()
  let next = 0
  scan(cReq(), res, () => {
    next++
  })
  assert.equal(next, 1, "C isolated from A and from collector")
  assert.equal(res.code, 200)
}

{
  const res = mockRes()
  let next = 0
  scan(aReq(), res, () => {
    next++
  })
  assert.equal(res.code, 429)
  assert.equal(next, 0)
  const cres = mockRes()
  let cnext = 0
  scan(cReq(), cres, () => {
    cnext++
  })
  assert.equal(cnext, 1, "C not starved when A hits its own bucket")
}

{
  const res = mockRes()
  let next = 0
  general(mockReq({ headers: { authorization: collectorTok } }), res, () => {
    next++
  })
  assert.equal(next, 1)
}

{
  const res = mockRes()
  hashedAuthorizationSubject("Bearer wrong-token-wrong-token-wrong-xx", ip)
  let next = 0
  const unauth = createRateLimiter({
    name: "amazon-scan-worker",
    windowMs: 60_000,
    max: 3,
    keyFn: req => internalScraperRateLimitKey(req, String(req.body?.workerId ?? "")),
  })
  const bad = mockReq({
    headers: { authorization: "Bearer wrong-token-wrong-token-wrong-xx" },
    body: { workerId: "amazon-keepa-verify-primary-A" },
  })
  for (let i = 0; i < 3; i++) unauth(bad, mockRes(), () => {})
  unauth(bad, res, () => {
    next++
  })
  assert.equal(res.code, 429)
}

const httpServer = fs.readFileSync(path.join(__dirname, "../modules/http/httpServer.ts"), "utf8")
assert.match(httpServer, /isInternalScraperApiPath/)
assert.match(httpServer, /keepa-collector-observations/)
assert.match(httpServer, /amazon-scan-worker/)
assert.match(httpServer, /oxylabs-verify-worker/)
assert.match(httpServer, /max: 4000/)

const persistSrc = fs.readFileSync(path.join(__dirname, "../modules/keepaSensor/keepaObservationEvaluate.ts"), "utf8")
assert.match(persistSrc, /ON CONFLICT \(asin, fingerprint\) DO NOTHING/)
assert.match(persistSrc, /ON CONFLICT \(asin\) DO UPDATE SET/)
assert.match(persistSrc, /ebayMutationCalls: 0/)

const authSrc = fs.readFileSync(path.join(__dirname, "../modules/keepaSensor/keepaCollectorAuth.ts"), "utf8")
assert.match(authSrc, /evaluateKeepaCollectorRouteAuth/)
const scanAuth = fs.readFileSync(path.join(__dirname, "../modules/amazonScan/amazonScanWorkerAuth.ts"), "utf8")
assert.match(scanAuth, /timingSafeTokenEqual/)

console.log("PASS internal scraper rate-limit isolation + Retry-After + hashed subject + observation idempotency")
