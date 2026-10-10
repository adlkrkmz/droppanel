import "dotenv/config"
import { query, db } from "../db/client"
import { loadKeepaCollectorReconcileRows } from "../modules/keepaSensor/keepaCollectorSnapshot"

const live = "LOWER(COALESCE(scs.current_status::text, '')) NOT IN ('ended','ended_by_seller','ended_by_ebay')"
async function main() {
  const rows = await loadKeepaCollectorReconcileRows()
  const m = (await query<{missing:string; zero:string; recovery_consumers:string; recovery_asins:string; wrongly_removed:string; wrongly_normal:string; ended_monitored:string; collector_orphans:string; sync_drift:string}>(
   `WITH z AS (SELECT scs.id,scs.workspace_id,scs.store_id,COALESCE(scs.ebay_quantity,0) qty,scs.bot_zeroed_at,
    COALESCE(ar.asin,substring(scs.source_url from 'amazon\\.com/(?:dp|gp/product)/([A-Za-z0-9]{10})'),scs.internal_sku) asin
    FROM store_catalog_state scs LEFT JOIN asin_registry ar ON ar.id=scs.asin_registry_id AND ar.workspace_id=scs.workspace_id WHERE ${live}),
   eligible AS (SELECT * FROM z WHERE qty>0 OR bot_zeroed_at IS NOT NULL),
   zr AS (SELECT * FROM z WHERE qty<=0 AND bot_zeroed_at IS NOT NULL)
   SELECT
    (SELECT COUNT(*) FROM eligible e LEFT JOIN global_asin_consumers c ON c.catalog_state_id=e.id WHERE e.asin ~* '^[A-Z0-9]{10}$' AND c.catalog_state_id IS NULL)::text missing,
    (SELECT COUNT(*) FROM zr)::text zero,
    (SELECT COUNT(*) FROM zr JOIN global_asin_consumers c ON c.catalog_state_id=zr.id)::text recovery_consumers,
    (SELECT COUNT(DISTINCT upper(asin)) FROM zr WHERE asin ~* '^[A-Z0-9]{10}$')::text recovery_asins,
    (SELECT COUNT(DISTINCT upper(zr.asin)) FROM zr LEFT JOIN keepa_asin_sync_state s ON s.asin=upper(zr.asin) WHERE zr.asin ~* '^[A-Z0-9]{10}$' AND COALESCE(s.status,'REMOVED')='REMOVED')::text wrongly_removed,
    (SELECT COUNT(DISTINCT upper(zr.asin)) FROM zr LEFT JOIN keepa_asin_sync_state s ON s.asin=upper(zr.asin) WHERE zr.asin ~* '^[A-Z0-9]{10}$' AND s.status='ACTIVE' AND s.cadence_hours IN (12,24))::text wrongly_normal,
    (SELECT COUNT(*) FROM global_asin_consumers c JOIN store_catalog_state scs ON scs.id=c.catalog_state_id WHERE NOT (${live}))::text ended_monitored,
    (SELECT COUNT(*) FROM keepa_asin_sync_state s WHERE s.status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM eligible e WHERE upper(e.asin)=s.asin AND e.asin ~* '^[A-Z0-9]{10}$'))::text collector_orphans,
    (SELECT COUNT(*) FROM keepa_asin_sync_state s WHERE s.status='ACTIVE' AND s.cadence_hours NOT IN (12,24,120))::text sync_drift`)).rows[0]
  const outbox = await query<{status:string;n:string}>(`SELECT status,COUNT(*)::text n FROM keepa_asin_sync_outbox GROUP BY status`)
  const consumers = await query<{eligible:string;zero:string}>(
    `SELECT COUNT(*) FILTER (WHERE LOWER(COALESCE(scs.current_status::text,'live')) NOT IN ('ended','ended_by_seller','ended_by_ebay') AND (COALESCE(scs.ebay_quantity,0)>0 OR scs.bot_zeroed_at IS NOT NULL))::text eligible,
            COUNT(*) FILTER (WHERE LOWER(COALESCE(scs.current_status::text,'live')) NOT IN ('ended','ended_by_seller','ended_by_ebay') AND COALESCE(scs.ebay_quantity,0)<=0 AND scs.bot_zeroed_at IS NOT NULL)::text zero
     FROM global_asin_consumers c JOIN store_catalog_state scs ON scs.id=c.catalog_state_id`)
  const tel = await query<{collected_at:Date;payload:Record<string,unknown>}>(`SELECT collected_at,payload FROM keepa_collector_host_telemetry ORDER BY collected_at DESC LIMIT 1`)
  const cadence = { sold12:0, standard24:0, zero120:0, active:0, paused:0 }
  for (const r of rows) { if (r.status === "ACTIVE") { cadence.active++; if (r.cadenceHours===12) cadence.sold12++; else if(r.cadenceHours===24) cadence.standard24++; else if(r.cadenceHours===120) cadence.zero120++ } else cadence.paused++ }
  const p=tel.rows[0]?.payload||{}
  console.log(JSON.stringify({ ...m, ...cadence, activeConsumers:Number(consumers.rows[0]?.eligible||0), recoveryConsumersActual:Number(consumers.rows[0]?.zero||0), outbox:Object.fromEntries(outbox.rows.map(x=>[x.status,Number(x.n)])), heartbeatAt:tel.rows[0]?.collected_at?.toISOString()||null, collectorVersion:p.collectorVersion||null, collectorActive:p.registryActiveAsins??p.activeAsins??p.registryActive??null, telemetry:p }))
  await db.end()
}
void main().catch(async e=>{console.error(e);await db.end();process.exit(1)})
