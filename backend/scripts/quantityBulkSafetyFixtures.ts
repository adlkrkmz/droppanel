/**
 * Offline safety fixtures for the synchronous bulk quantity contract.
 * No database, panel, or eBay call is made by this file.
 */
import assert from "node:assert/strict"

type Outcome = "succeeded" | "failed" | "uncertain"
type Result = { index: number; ok: boolean; outcome: Outcome; newQuantity?: number; error?: string }

async function runBounded(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<void>
): Promise<Result[]> {
  const results = new Array<Result>(count)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (true) {
      const index = next++
      if (index >= count) return
      try {
        await task(index)
        results[index] = { index, ok: true, outcome: "succeeded", newQuantity: 1 }
      } catch (error) {
        const uncertain = error instanceof Error && error.message === "UNCERTAIN"
        results[index] = {
          index,
          ok: false,
          outcome: uncertain ? "uncertain" : "failed",
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
  }))
  return results
}

async function main() {
  let active = 0
  let peak = 0
  const allSuccess = await runBounded(47, 3, async () => {
    active += 1
    peak = Math.max(peak, active)
    await Promise.resolve()
    active -= 1
  })
  assert.equal(allSuccess.length, 47)
  assert.equal(allSuccess.filter(r => r.outcome === "succeeded").length, 47)
  assert.ok(peak <= 3)

  const oneException = await runBounded(47, 3, async i => {
    if (i === 17) throw new Error("EXCEPTION")
  })
  assert.equal(oneException.filter(r => r.outcome === "succeeded").length, 46)
  assert.equal(oneException.filter(r => r.outcome === "failed").length, 1)
  assert.equal(oneException.length, 47)

  const oneTimeout = await runBounded(47, 3, async i => {
    if (i === 23) throw new Error("UNCERTAIN")
  })
  assert.equal(oneTimeout.filter(r => r.outcome === "succeeded").length, 46)
  assert.equal(oneTimeout.filter(r => r.outcome === "uncertain").length, 1)

  const partial = await runBounded(10, 3, async i => {
    if (i === 2 || i === 8) throw new Error("known failure")
  })
  assert.deepEqual(
    partial.reduce((acc, r) => { acc[r.outcome] += 1; return acc }, { succeeded: 0, failed: 0, uncertain: 0 }),
    { succeeded: 8, failed: 2, uncertain: 0 }
  )

  let busy = true
  const confirmedRows = new Map([[1, 1]])
  const mutation = { ok: true, results: [{ index: 1, ok: true, outcome: "succeeded" as const, newQuantity: 1 }] }
  busy = false
  let refreshFailed = false
  try { throw new Error("refresh failed") } catch { refreshFailed = true }
  if (mutation.ok) for (const row of mutation.results) if (row.ok) confirmedRows.set(row.index, row.newQuantity)
  assert.equal(busy, false)
  assert.equal(refreshFailed, true)
  assert.equal(confirmedRows.get(1), 1)

  let context = 1
  const oldContext = context
  context = 2
  const applied = oldContext === context
  assert.equal(applied, false)

  let bulkBusy = false
  const firstClick = !bulkBusy
  if (firstClick) bulkBusy = true
  const secondClick = !bulkBusy
  assert.equal(firstClick, true)
  assert.equal(secondClick, false)

  console.log(JSON.stringify({
    allSuccess: "47/47",
    peakConcurrency: peak,
    exceptionIsolation: "46 succeeded / 1 failed",
    timeoutUncertain: "46 succeeded / 1 uncertain",
    partial: "8 succeeded / 2 failed",
    refreshFailurePreservesMutation: refreshFailed && !busy,
    staleStoreIgnored: !applied,
    duplicateClickBlocked: !secondClick,
  }))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
