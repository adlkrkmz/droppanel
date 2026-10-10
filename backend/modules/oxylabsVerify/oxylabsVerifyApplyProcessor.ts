import { db } from "../../db/client"
import { loadOxylabsVerifyConfig } from "./oxylabsVerifyConfig"
import { applyOxylabsCompletedScanJob } from "./oxylabsVerifyApply"
import { markApplyOutboxDone, markApplyOutboxRetry } from "../amazonScan/amazonScanJobQueue"
import { newOxylabsApplyOwner } from "./oxylabsApplyOperations"

async function claimOxylabsApplyOutbox(limit: number): Promise<Array<{ id: number; jobId: number }>> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const res = await client.query(
      `WITH picked AS (
         SELECT o.id
         FROM amazon_scan_apply_outbox o
         JOIN amazon_scan_jobs j ON j.id = o.job_id
         WHERE o.status = 'PENDING' AND o.available_at <= NOW()
           AND (o.locked_until IS NULL OR o.locked_until < NOW())
           AND j.kind IN ('OXYLABS_PRODUCT_PRIMARY','OXYLABS_PRODUCT_CONFIRM')
         ORDER BY o.id ASC
         LIMIT $1::int
         FOR UPDATE OF o SKIP LOCKED
       )
       UPDATE amazon_scan_apply_outbox o
       SET locked_until = NOW() + interval '2 minutes', updated_at = NOW()
       FROM picked
       WHERE o.id = picked.id
       RETURNING o.id, o.job_id`,
      [Math.max(1, Math.min(10, limit))]
    )
    await client.query("COMMIT")
    return res.rows.map(r => ({ id: Number(r.id), jobId: Number(r.job_id) }))
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

let timer: NodeJS.Timeout | null = null
let running = false

async function tick(): Promise<void> {
  const cfg = loadOxylabsVerifyConfig()
  if (!cfg.applyProcessorEnabled) return
  const rows = await claimOxylabsApplyOutbox(5)
  for (const row of rows) {
    try {
      await applyOxylabsCompletedScanJob(row.jobId, { owner: newOxylabsApplyOwner("processor") })
      await markApplyOutboxDone(row.id)
    } catch (e) {
      await markApplyOutboxRetry(row.id, e instanceof Error ? e.message : String(e))
    }
  }
}

export function startOxylabsVerifyApplyProcessor(): void {
  const cfg = loadOxylabsVerifyConfig()
  if (!cfg.applyProcessorEnabled) {
    console.log("[OxylabsVerifyApply] disabled")
    return
  }
  if (timer) return
  timer = setInterval(() => {
    if (running) return
    running = true
    void tick().finally(() => {
      running = false
    })
  }, 2000)
  console.log(`[OxylabsVerifyApply] processor started mutations=${cfg.mutationsEnabled}`)
}
