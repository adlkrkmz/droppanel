import "dotenv/config"
import assert from "assert"
import { query } from "../db/client"
import {
  claimOxylabsApplyOperation,
  getOxylabsApplyOperation,
  oxylabsMutationOperationKey,
  runOxylabsGuardedMutation,
  type OxylabsApplyAction,
} from "../modules/oxylabsVerify/oxylabsApplyOperations"
import { applyOxylabsCompletedScanJob } from "../modules/oxylabsVerify/oxylabsVerifyApply"

const JOB_ID = 6938
const CATALOG = 2793
const PREFIX = `conc-${Date.now()}`

function key(suffix: string, action: OxylabsApplyAction = "zero_stock", catalog = CATALOG): string {
  return oxylabsMutationOperationKey({
    provider: "OXYLABS_PRODUCT",
    jobId: JOB_ID,
    candidateId: 1,
    fingerprint: `${PREFIX}:${suffix}`,
    action,
    target: action === "zero_stock" ? "qty:0" : "amazon_cents:1999",
    catalogStateId: catalog,
  })
}

async function expire(operationKey: string): Promise<void> {
  await query(
    `UPDATE oxylabs_apply_operations
     SET lease_until = NOW() - interval '1 second', updated_at = NOW()
     WHERE operation_key = $1`,
    [operationKey]
  )
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function run(input: {
  suffix: string
  owner: string
  action?: OxylabsApplyAction
  catalog?: number
  mutate: () => Promise<{ ok: boolean; ebayMutated: boolean; error?: string }>
  readback: () => Promise<{ matchesTarget: boolean; observed: string | null }>
}) {
  const action = input.action ?? "zero_stock"
  return runOxylabsGuardedMutation({
    operationKey: key(input.suffix, action, input.catalog),
    jobId: JOB_ID,
    catalogStateId: input.catalog ?? CATALOG,
    action,
    target: action === "zero_stock" ? "qty:0" : "amazon_cents:1999",
    owner: input.owner,
    mutate: input.mutate,
    readback: input.readback,
  })
}

async function main(): Promise<void> {
  const job = await query(`SELECT id FROM amazon_scan_jobs WHERE id = $1::bigint`, [JOB_ID])
  assert.ok(job.rows[0], "anchor job missing")

  // 1. Promise.all zero-stock handler+processor
  {
    let mutate = 0
    let readback = 0
    const mutateFn = async () => {
      mutate++
      await delay(40)
      return { ok: true, ebayMutated: true }
    }
    const readbackFn = async () => {
      readback++
      return { matchesTarget: false, observed: "1" }
    }
    const [a, b] = await Promise.all([
      run({ suffix: "s1", owner: "handler", mutate: mutateFn, readback: readbackFn }),
      run({ suffix: "s1", owner: "processor", mutate: mutateFn, readback: readbackFn }),
    ])
    const kinds = [a.skipped, b.skipped].sort()
    assert.equal(mutate, 1)
    assert.ok(a.applied !== b.applied)
    assert.ok(kinds.includes("already_claimed") || kinds.includes("already_applied"))
    const row = await getOxylabsApplyOperation(key("s1"))
    assert.equal(row?.status, "APPLIED")
    assert.equal(row?.ebayMutateCount, 1)
    assert.equal(readback, 0)
  }

  // 2. concurrent price-change
  {
    let mutate = 0
    const mutateFn = async () => {
      mutate++
      await delay(40)
      return { ok: true, ebayMutated: true }
    }
    await Promise.all([
      run({
        suffix: "s2",
        owner: "handler",
        action: "profit_protection",
        mutate: mutateFn,
        readback: async () => ({ matchesTarget: false, observed: null }),
      }),
      run({
        suffix: "s2",
        owner: "processor",
        action: "profit_protection",
        mutate: mutateFn,
        readback: async () => ({ matchesTarget: false, observed: null }),
      }),
    ])
    assert.equal(mutate, 1)
    assert.equal((await getOxylabsApplyOperation(key("s2", "profit_protection")))?.status, "APPLIED")
  }

  // 3. first eBay fail; parallel second does not call
  {
    let mutate = 0
    const mutateFn = async () => {
      mutate++
      await delay(40)
      return { ok: false, ebayMutated: false, error: "ebay_500" }
    }
    const [a, b] = await Promise.all([
      run({ suffix: "s3", owner: "handler", mutate: mutateFn, readback: async () => ({ matchesTarget: false, observed: "1" }) }),
      run({ suffix: "s3", owner: "processor", mutate: mutateFn, readback: async () => ({ matchesTarget: false, observed: "1" }) }),
    ])
    assert.equal(mutate, 1)
    const skips = [a.skipped, b.skipped]
    assert.ok(skips.includes("RETRYABLE"))
    assert.ok(skips.includes("already_claimed"))
    const row = await getOxylabsApplyOperation(key("s3"))
    assert.equal(row?.status, "RETRYABLE")
    assert.equal(row?.ebayMutateCount, 1)
  }

  // 4. lease expiry + target already applied → readback only
  {
    let mutate = 0
    let reads = 0
    await run({
      suffix: "s4",
      owner: "first",
      mutate: async () => {
        mutate++
        return { ok: true, ebayMutated: true }
      },
      readback: async () => ({ matchesTarget: false, observed: "1" }),
    })
    await query(
      `UPDATE oxylabs_apply_operations
       SET status = 'CLAIMED', applied_at = NULL, lease_until = NOW() - interval '1 second'
       WHERE operation_key = $1`,
      [key("s4")]
    )
    mutate = 0
    const r = await run({
      suffix: "s4",
      owner: "recover",
      mutate: async () => {
        mutate++
        return { ok: true, ebayMutated: true }
      },
      readback: async () => {
        reads++
        return { matchesTarget: true, observed: "0" }
      },
    })
    assert.equal(r.recovered, true)
    assert.equal(mutate, 0)
    assert.equal(reads, 1)
    assert.equal((await getOxylabsApplyOperation(key("s4")))?.status, "APPLIED")
  }

  // 5. lease expiry + not applied → one retry; concurrent second 0
  {
    let mutate = 0
    await run({
      suffix: "s5",
      owner: "first",
      mutate: async () => {
        mutate++
        return { ok: false, ebayMutated: false, error: "fail" }
      },
      readback: async () => ({ matchesTarget: false, observed: "1" }),
    })
    await expire(key("s5"))
    mutate = 0
    const mutateFn = async () => {
      mutate++
      await delay(40)
      return { ok: true, ebayMutated: true }
    }
    await Promise.all([
      run({ suffix: "s5", owner: "r1", mutate: mutateFn, readback: async () => ({ matchesTarget: false, observed: "1" }) }),
      run({ suffix: "s5", owner: "r2", mutate: mutateFn, readback: async () => ({ matchesTarget: false, observed: "1" }) }),
    ])
    assert.equal(mutate, 1)
    assert.equal((await getOxylabsApplyOperation(key("s5")))?.status, "APPLIED")
  }

  // 6. handler first then processor → processor eBay 0
  {
    let mutate = 0
    const mutateFn = async () => {
      mutate++
      return { ok: true, ebayMutated: true }
    }
    const rb = async () => ({ matchesTarget: false, observed: "1" as string })
    await run({ suffix: "s6", owner: "handler", mutate: mutateFn, readback: rb })
    const second = await run({ suffix: "s6", owner: "processor", mutate: mutateFn, readback: rb })
    assert.equal(mutate, 1)
    assert.equal(second.skipped, "already_applied")
  }

  // 7. processor first then handler → handler eBay 0
  {
    let mutate = 0
    const mutateFn = async () => {
      mutate++
      return { ok: true, ebayMutated: true }
    }
    const rb = async () => ({ matchesTarget: false, observed: "1" as string })
    await run({ suffix: "s7", owner: "processor", mutate: mutateFn, readback: rb })
    const second = await run({ suffix: "s7", owner: "handler", mutate: mutateFn, readback: rb })
    assert.equal(mutate, 1)
    assert.equal(second.skipped, "already_applied")
  }

  // 8. replay → new mutation 0
  {
    let mutate = 0
    const mutateFn = async () => {
      mutate++
      return { ok: true, ebayMutated: true }
    }
    const rb = async () => ({ matchesTarget: false, observed: "1" as string })
    await run({ suffix: "s8", owner: "a", mutate: mutateFn, readback: rb })
    await run({ suffix: "s8", owner: "b", mutate: mutateFn, readback: rb })
    assert.equal(mutate, 1)
  }

  // 9. listing not live / qty 0 / mismatch: completed apply does not call eBay mocks
  {
    let zero = 0
    let price = 0
    const r6938 = await applyOxylabsCompletedScanJob(6938, {
      owner: "test",
      applyZero: async () => {
        zero++
        throw new Error("must not call eBay")
      },
      applyPrice: async () => {
        price++
        throw new Error("must not call eBay")
      },
    })
    assert.equal(zero, 0)
    assert.equal(price, 0)
    assert.equal(r6938.applied, 0)
    const r6936 = await applyOxylabsCompletedScanJob(6936, {
      owner: "test",
      applyZero: async () => {
        zero++
        throw new Error("must not call eBay")
      },
    })
    assert.equal(zero, 0)
    assert.equal(r6936.applied, 0)
  }

  // 10. different operation keys do not block
  {
    let mutate = 0
    const mutateFn = async () => {
      mutate++
      await delay(20)
      return { ok: true, ebayMutated: true }
    }
    const rb = async () => ({ matchesTarget: false, observed: "1" as string })
    await Promise.all([
      run({ suffix: "s10a", owner: "a", mutate: mutateFn, readback: rb }),
      run({ suffix: "s10b", owner: "b", mutate: mutateFn, readback: rb, catalog: 2793 + 1 }),
    ])
    assert.equal(mutate, 2)
  }

  const claimRace = await Promise.all([
    claimOxylabsApplyOperation({
      operationKey: key("claim-only"),
      jobId: JOB_ID,
      catalogStateId: CATALOG,
      action: "zero_stock",
      target: "qty:0",
      owner: "h",
    }),
    claimOxylabsApplyOperation({
      operationKey: key("claim-only"),
      jobId: JOB_ID,
      catalogStateId: CATALOG,
      action: "zero_stock",
      target: "qty:0",
      owner: "p",
    }),
  ])
  const won = claimRace.filter(c => c.kind === "WON")
  const blocked = claimRace.filter(c => c.kind === "already_claimed" || c.kind === "already_applied")
  assert.equal(won.length, 1)
  assert.equal(blocked.length, 1)

  console.log("PASS oxylabs apply concurrency fixtures")
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
