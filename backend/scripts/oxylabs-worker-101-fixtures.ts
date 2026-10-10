import "dotenv/config"
import assert from "assert"
import { evaluateOxylabsVerifyRouteAuth } from "../modules/oxylabsVerify/oxylabsVerifyAuth"
import { resolveOxylabsVerifyClaimKind } from "../modules/oxylabsVerify/oxylabsVerifyKinds"
import {
  isOxylabsTerminalFailCode,
  normalizeOxylabsFailCode,
  OXYLABS_CALL_OUTCOME_UNKNOWN,
} from "../modules/oxylabsVerify/oxylabsVerifyFailPolicy"
import { reserveOxylabsProviderCall, countOxylabsCallReservations } from "../modules/oxylabsVerify/oxylabsVerifyReservations"
import { db } from "../db/client"

async function main(): Promise<void> {
  assert.equal(resolveOxylabsVerifyClaimKind("oxylabs-product-primary-A"), "OXYLABS_PRODUCT_PRIMARY")
  assert.equal(resolveOxylabsVerifyClaimKind("oxylabs-product-confirm-C"), "OXYLABS_PRODUCT_CONFIRM")
  assert.equal(resolveOxylabsVerifyClaimKind("nope"), null)
  console.log("PASS G role isolation")

  const wrong = evaluateOxylabsVerifyRouteAuth({
    protocolEnabled: false,
    tokenConfigured: true,
    tokenOk: false,
    foreignToken: false,
    hasSessionCookie: false,
  })
  if (!("ok" in wrong)) assert.equal(wrong.status, 401)
  const cookie = evaluateOxylabsVerifyRouteAuth({
    protocolEnabled: false,
    tokenConfigured: true,
    tokenOk: true,
    foreignToken: false,
    hasSessionCookie: true,
  })
  if (!("ok" in cookie)) assert.equal(cookie.status, 401)
  const amazon = evaluateOxylabsVerifyRouteAuth({
    protocolEnabled: false,
    tokenConfigured: true,
    tokenOk: false,
    foreignToken: true,
    hasSessionCookie: false,
  })
  if (!("ok" in amazon)) assert.equal(amazon.status, 401)
  const proto = evaluateOxylabsVerifyRouteAuth({
    protocolEnabled: false,
    tokenConfigured: true,
    tokenOk: true,
    foreignToken: false,
    hasSessionCookie: false,
  })
  if (!("ok" in proto)) {
    assert.equal(proto.status, 503)
    assert.equal(proto.error, "OXYLABS_VERIFY_PROTOCOL_DISABLED")
  }
  console.log("PASS E auth 401/503 order")
  assert.equal(isOxylabsTerminalFailCode(normalizeOxylabsFailCode("CALL_OUTCOME_UNKNOWN")), true)
  assert.equal(normalizeOxylabsFailCode("CALL_OUTCOME_UNKNOWN"), OXYLABS_CALL_OUTCOME_UNKNOWN)

  const BASE = 910000000
  const before = await countOxylabsCallReservations()
  const cap = before + 20
  const clientA = await db.connect()
  const clientB = await db.connect()
  try {
    await clientA.query("DELETE FROM oxylabs_verify_call_reservations WHERE job_id >= $1 AND job_id < $2", [BASE, BASE + 100])
    const work = async (client: typeof clientA, start: number, n: number) => {
      let won = 0
      for (let i = 0; i < n; i++) {
        await client.query("BEGIN")
        try {
          const slot = await reserveOxylabsProviderCall({
            client,
            jobId: BASE + start + i,
            workerId: (start + i) % 2 === 0 ? "oxylabs-product-primary-A" : "oxylabs-product-confirm-C",
            cap,
          })
          if (slot.reserved && !slot.existing) won++
          await client.query("COMMIT")
        } catch (e) {
          await client.query("ROLLBACK")
          throw e
        }
      }
      return won
    }
    const [a, b] = await Promise.all([work(clientA, 0, 13), work(clientB, 13, 12)])
    const mine = await db.query(
      `SELECT COUNT(*)::int AS c FROM oxylabs_verify_call_reservations WHERE job_id >= $1 AND job_id < $2`,
      [BASE, BASE + 100]
    )
    const unique = Number(mine.rows[0].c)
    assert.equal(a + b, unique)
    assert.equal(unique, 20)
    const replay = await db.connect()
    try {
      await replay.query("BEGIN")
      const again = await reserveOxylabsProviderCall({
        client: replay,
        jobId: BASE,
        workerId: "oxylabs-product-primary-A",
        cap,
      })
      await replay.query("ROLLBACK")
      assert.equal(again.existing, true)
      assert.equal(again.reserved, true)
    } finally {
      replay.release()
    }
    console.log(`PASS D canary concurrency unique=${unique} parallel=${a}+${b}`)
  } finally {
    await clientA.query("DELETE FROM oxylabs_verify_call_reservations WHERE job_id >= $1 AND job_id < $2", [
      BASE,
      BASE + 100,
    ])
    clientA.release()
    clientB.release()
  }
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
