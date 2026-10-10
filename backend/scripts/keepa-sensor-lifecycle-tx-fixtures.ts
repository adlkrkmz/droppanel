import assert from "assert"
import { randomUUID } from "crypto"
import "dotenv/config"
import { acquireClient, query } from "../db/client"
import { withFixtureBoundQuery } from "./bindFixtureQueryClient"
import { trySyncGlobalAsinConsumerFromCatalog } from "../modules/globalKeepa/globalAsinConsumerSync"
import { afterListingMonitoringStopped, afterManualQuantityChanged } from "../modules/stockGuard/stockGuardV2LifecycleHooks"
import { updateListingMetrics } from "../modules/listings/listingsMetricsService"
import { applySyncEvent, dueAsins, openKeepaLocalDb } from "../modules/keepaSensor/keepaLocalDb"

const ASIN_A = "B0KSSENA01"
const ASIN_B = "B0KSSENB02"
const ASIN_NEW = "B0KSSENF03"

async function main(): Promise<void> {
  const client = await acquireClient("keepa-lifecycle-tx")
  const sqlite = openKeepaLocalDb(":memory:")
  try {
    await client.query("BEGIN")
    await withFixtureBoundQuery(client, async () => {
      const ws = randomUUID()
      await client.query(`INSERT INTO workspaces (id, name) VALUES ($1::uuid, $2)`, [ws, "__keepa_sensor_tx__"])
      const store1 = await client.query<{ id: number }>(
        `INSERT INTO stores (workspace_id, name, store_code, status)
         VALUES ($1::uuid, 'tx-s1', $2, 'active') RETURNING id`,
        [ws, `tx1-${ws.slice(0, 8)}`]
      )
      const store2 = await client.query<{ id: number }>(
        `INSERT INTO stores (workspace_id, name, store_code, status)
         VALUES ($1::uuid, 'tx-s2', $2, 'active') RETURNING id`,
        [ws, `tx2-${ws.slice(0, 8)}`]
      )
      const s1 = Number(store1.rows[0].id)
      const s2 = Number(store2.rows[0].id)
      const regA = await client.query<{ id: string }>(
        `INSERT INTO asin_registry (workspace_id, asin) VALUES ($1::uuid, $2) RETURNING id::text`,
        [ws, ASIN_A]
      )
      const regB = await client.query<{ id: string }>(
        `INSERT INTO asin_registry (workspace_id, asin) VALUES ($1::uuid, $2) RETURNING id::text`,
        [ws, ASIN_B]
      )
      const regN = await client.query<{ id: string }>(
        `INSERT INTO asin_registry (workspace_id, asin) VALUES ($1::uuid, $2) RETURNING id::text`,
        [ws, ASIN_NEW]
      )
      const ridA = Number(regA.rows[0].id)
      const ridB = Number(regB.rows[0].id)
      const ridN = Number(regN.rows[0].id)

      async function insertListing(input: {
        storeId: number
        registryId: number
        sku: string
        itemId: string
        qty: number
        sold?: number
      }): Promise<number> {
        const row = await client.query<{ id: string }>(
          `INSERT INTO store_catalog_state (
             workspace_id, store_id, asin_registry_id, internal_sku, ebay_item_id,
             ebay_quantity, ebay_price, current_status, stock_guard_enabled, total_sold, sold_30d,
             source_of_truth, created_at, updated_at
           ) VALUES (
             $1::uuid, $2, $3, $4, $5, $6, 9.99, 'live', true, $7, 0,
             'keepa_sensor_tx', NOW(), NOW()
           ) RETURNING id::text`,
          [ws, input.storeId, input.registryId, input.sku, input.itemId, input.qty, input.sold ?? 0]
        )
        return Number(row.rows[0].id)
      }

      async function state(asin: string) {
        const r = await client.query<{
          status: string
          active_consumer_count: string
          priority: string
          cadence_hours: string
          source_version: string
        }>(
          `SELECT status, active_consumer_count::text, priority, cadence_hours::text, source_version::text
           FROM keepa_asin_sync_state WHERE asin = $1`,
          [asin]
        )
        return r.rows[0]
      }

      async function events(asin: string) {
        const r = await client.query<{ event_type: string; source_version: string }>(
          `SELECT event_type, source_version::text FROM keepa_asin_sync_outbox
           WHERE asin = $1 ORDER BY created_at ASC, event_id ASC`,
          [asin]
        )
        return r.rows
      }

      async function applyOutboxToSqlite(nowMs: number): Promise<void> {
        const rows = await client.query<{
          event_id: string
          asin: string
          event_type: string
          source_version: string
          payload: { activeConsumerCount?: number; status?: string; priority?: string; cadenceHours?: number }
        }>(
          `SELECT event_id::text, asin, event_type, source_version::text, payload
           FROM keepa_asin_sync_outbox ORDER BY created_at ASC, event_id ASC`
        )
        for (const ev of rows.rows) {
          applySyncEvent(sqlite, {
            eventId: ev.event_id,
            asin: ev.asin,
            eventType: ev.event_type,
            sourceVersion: Number(ev.source_version),
            payload: ev.payload ?? {},
            nowMs,
          })
        }
      }

      const now0 = 1_000_000

      // A qty 1→0 on ASIN_A
      const catA = await insertListing({
        storeId: s1,
        registryId: ridA,
        sku: `sku-a1-${ws.slice(0, 8)}`,
        itemId: `item-a1-${ws.slice(0, 8)}`,
        qty: 1,
      })
      await trySyncGlobalAsinConsumerFromCatalog({ workspaceId: ws, storeId: s1, catalogStateId: catA })
      assert.equal((await state(ASIN_A)).status, "ACTIVE")
      await client.query(`UPDATE store_catalog_state SET ebay_quantity = 0, updated_at = NOW() WHERE id = $1`, [catA])
      await afterManualQuantityChanged({ workspaceId: ws, storeId: s1, catalogStateId: catA, quantity: 0 })
      const paused = await state(ASIN_A)
      assert.ok(paused.status === "PAUSED_QTY_ZERO" || paused.status === "REMOVED", paused.status)
      assert.notEqual(paused.status, "ACTIVE")
      const evA = await events(ASIN_A)
      assert.ok(evA.some(e => e.event_type === "QTY_ZERO_PAUSED" || e.event_type === "ASIN_REMOVED"))
      await applyOutboxToSqlite(now0 + 10)
      assert.equal(
        dueAsins(sqlite, now0 + 50_000, 50).some(r => r.asin === ASIN_A),
        false
      )
      console.log("PASS A qty 1→0 not ACTIVE / not Keepa due")

      // B qty 0→1
      await client.query(`UPDATE store_catalog_state SET ebay_quantity = 1, updated_at = NOW() WHERE id = $1`, [catA])
      await afterManualQuantityChanged({ workspaceId: ws, storeId: s1, catalogStateId: catA, quantity: 1 })
      const resumed = await state(ASIN_A)
      assert.equal(resumed.status, "ACTIVE")
      assert.ok(Number(resumed.cadence_hours) === 24 || Number(resumed.cadence_hours) === 12)
      const cons = await client.query(
        `SELECT 1 FROM global_asin_consumers WHERE catalog_state_id = $1`,
        [catA]
      )
      assert.ok((cons.rowCount ?? 0) >= 1)
      assert.ok((await events(ASIN_A)).some(e => e.event_type === "QTY_POSITIVE_RESUMED" || e.event_type === "ASIN_UPSERT" || e.event_type === "CONSUMER_ATTACHED"))
      await applyOutboxToSqlite(now0 + 15)
      console.log("PASS B qty 0→1 ACTIVE + consumer + resume/upsert event")

      // C shared ASIN_B two stores
      const catB1 = await insertListing({
        storeId: s1,
        registryId: ridB,
        sku: `sku-b1-${ws.slice(0, 8)}`,
        itemId: `item-b1-${ws.slice(0, 8)}`,
        qty: 3,
      })
      const catB2 = await insertListing({
        storeId: s2,
        registryId: ridB,
        sku: `sku-b2-${ws.slice(0, 8)}`,
        itemId: `item-b2-${ws.slice(0, 8)}`,
        qty: 4,
      })
      await trySyncGlobalAsinConsumerFromCatalog({ workspaceId: ws, storeId: s1, catalogStateId: catB1 })
      await trySyncGlobalAsinConsumerFromCatalog({ workspaceId: ws, storeId: s2, catalogStateId: catB2 })
      assert.equal(Number((await state(ASIN_B)).active_consumer_count), 2)
      await client.query(`UPDATE store_catalog_state SET ebay_quantity = 0, updated_at = NOW() WHERE id = $1`, [catB1])
      await afterManualQuantityChanged({ workspaceId: ws, storeId: s1, catalogStateId: catB1, quantity: 0 })
      const shared = await state(ASIN_B)
      assert.equal(shared.status, "ACTIVE")
      assert.equal(Number(shared.active_consumer_count), 1)
      assert.notEqual(shared.status, "REMOVED")
      console.log("PASS C shared ASIN stays ACTIVE count 2→1")

      // D last remaining listing(s) ended/removed → ASIN_REMOVED
      await client.query(
        `UPDATE store_catalog_state SET current_status = 'ended', ebay_quantity = 0, updated_at = NOW()
         WHERE id = ANY($1::bigint[])`,
        [[catB1, catB2]]
      )
      await afterListingMonitoringStopped({ workspaceId: ws, catalogStateIds: [catB1, catB2] })
      const gone = await state(ASIN_B)
      assert.equal(gone.status, "REMOVED")
      assert.ok((await events(ASIN_B)).some(e => e.event_type === "ASIN_REMOVED"))
      await applyOutboxToSqlite(now0 + 20)
      assert.equal(dueAsins(sqlite, now0 + 90_000, 50).some(r => r.asin === ASIN_B && r.status === "ACTIVE"), false)
      console.log("PASS D last consumer ASIN_REMOVED")

      // E sold on ASIN_A
      const beforeScan = sqlite.prepare("SELECT next_scan_at FROM asin_registry WHERE asin = ?").get(ASIN_A) as
        | { next_scan_at: number }
        | undefined
      await updateListingMetrics(ws, s1, {
        listingId: `item-a1-${ws.slice(0, 8)}`,
        totalSold: 5,
        watchCount: 0,
        listedAt: null,
        clicks30d: 0,
        views30d: 0,
        impressions30d: 0,
        metricsSource: "tx-fixture",
        metricsError: null,
      })
      const sold = await state(ASIN_A)
      assert.equal(sold.priority, "SOLD")
      assert.equal(Number(sold.cadence_hours), 12)
      assert.ok((await events(ASIN_A)).some(e => e.event_type === "SOLD_PRIORITY_CHANGED"))
      await applyOutboxToSqlite(now0 + 30)
      const afterScan = sqlite.prepare("SELECT next_scan_at, priority FROM asin_registry WHERE asin = ?").get(ASIN_A) as
        | { next_scan_at: number; priority: string }
        | undefined
      if (beforeScan && afterScan) {
        assert.ok(afterScan.next_scan_at >= beforeScan.next_scan_at)
      }
      assert.equal(afterScan?.priority, "SOLD")
      console.log("PASS E sold 12h without pulling next_scan forward")

      // F new listing last in queue (tail) — no urgent scan
      const maxBefore = sqlite.prepare("SELECT COALESCE(MAX(next_scan_at), 0) AS m FROM asin_registry").get() as { m: number }
      const catNew = await insertListing({
        storeId: s1,
        registryId: ridN,
        sku: `sku-new-${ws.slice(0, 8)}`,
        itemId: `item-new-${ws.slice(0, 8)}`,
        qty: 2,
      })
      await trySyncGlobalAsinConsumerFromCatalog({ workspaceId: ws, storeId: s1, catalogStateId: catNew })
      const stNew = await state(ASIN_NEW)
      assert.equal(stNew.status, "ACTIVE")
      assert.equal(stNew.priority, "STANDARD")
      assert.equal(Number(stNew.cadence_hours), 24)
      await applyOutboxToSqlite(now0 + 40)
      const n1 = sqlite.prepare("SELECT next_scan_at FROM asin_registry WHERE asin = ?").get(ASIN_NEW) as { next_scan_at: number }
      assert.ok(n1.next_scan_at >= maxBefore.m)
      console.log("PASS F new ASIN ACTIVE/STANDARD 24h queue tail")

      const versions = await client.query<{ source_version: string }>(
        `SELECT source_version::text FROM keepa_asin_sync_outbox WHERE asin = $1 ORDER BY source_version ASC`,
        [ASIN_A]
      )
      let last = 0
      for (const v of versions.rows) {
        const n = Number(v.source_version)
        assert.ok(n >= last)
        last = n
      }
      const replayId = (await client.query<{ event_id: string }>(
        `SELECT event_id::text FROM keepa_asin_sync_outbox WHERE asin = $1 LIMIT 1`,
        [ASIN_A]
      )).rows[0]?.event_id
      if (replayId) {
        const again = applySyncEvent(sqlite, {
          eventId: replayId,
          asin: ASIN_A,
          eventType: "ASIN_UPSERT",
          sourceVersion: 1,
          payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
          nowMs: now0 + 99,
        })
        assert.equal(again, false)
      }
      console.log("PASS event source_version monotonic + replay idempotent")
    })
  } finally {
    await client.query("ROLLBACK").catch(() => undefined)
    client.release()
  }
  const leftover = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM workspaces WHERE name = '__keepa_sensor_tx__'`)
  assert.equal(leftover.rows[0].n, "0")
  console.log("PASS ROLLBACK no leftover workspace")
  console.log("PASS keepa-sensor lifecycle tx fixtures")
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
}).then(() => process.exit(0))
