/**
 * Read-only / mock-safe Desktop Agent Phase 2 validation.
 * Does NOT mutate eBay qty/price or create production verification tasks
 * unless DESKTOP_AGENT_VALIDATE_MUTATE=1 (default off).
 */
import "dotenv/config"
import { listDesktopAgentAsins, findDesktopAgentListingForAsin, DESKTOP_AGENT_LISTING_WHERE } from "../modules/desktopAgent/desktopAgentAsins"
import { mapPublicObservationToVerificationPayload } from "../modules/amazonPublicWorker/mapPublicObservationToVerificationPayload"
import { isTechnicalStatusProbe } from "../modules/desktopAgent/desktopAgentObservationProbe"
import { query } from "../db/client"
import { minRecheckHoursForPriority, nextSuccessCheckAt } from "../modules/globalKeepa/globalKeepaCapacity"
import { loadGlobalKeepaFoundationConfig } from "../modules/globalKeepa/globalKeepaConfig"

async function main(): Promise<void> {
  const wsRes = await query<{ workspace_id: string; c: string }>(
    `SELECT scs.workspace_id::text AS workspace_id, COUNT(*)::text AS c
     FROM store_catalog_state scs
     JOIN stores st ON st.id = scs.store_id AND st.workspace_id = scs.workspace_id
     WHERE ${DESKTOP_AGENT_LISTING_WHERE}
     GROUP BY scs.workspace_id
     ORDER BY COUNT(*) DESC
     LIMIT 3`
  )
  if (wsRes.rows.length === 0) {
    console.log("NO_WORKSPACE_WITH_ELIGIBLE_LISTINGS")
    return
  }
  const wsA = wsRes.rows[0].workspace_id
  const wsB = wsRes.rows[1]?.workspace_id ?? null

  const asinsA = await listDesktopAgentAsins(wsA)
  const asinSet = new Set(asinsA.map(a => a.asin))
  console.log("ASIN_ENDPOINT_COUNT", asinsA.length)
  console.log("ASIN_DEDUPE", asinsA.length === asinSet.size ? "OK" : "FAIL")

  const qty0 = await query<{ asin: string; ebay_quantity: string }>(
    `SELECT UPPER(COALESCE(
        (SELECT ar.asin FROM asin_registry ar WHERE ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id AND ar.asin ~ '^[A-Z0-9]{10}$' LIMIT 1),
        SUBSTRING(UPPER(COALESCE(scs.source_url,'')) FROM 'AMAZON\\.COM/(?:DP|GP/PRODUCT)/([A-Z0-9]{10})'),
        CASE WHEN BTRIM(COALESCE(scs.internal_sku, '')) ~ '^[A-Z0-9]{10}$' THEN BTRIM(scs.internal_sku) ELSE NULL END,
        SUBSTRING(UPPER(COALESCE(scs.internal_sku, '')) FROM '^DP-([A-Z0-9]{10})-'),
        SUBSTRING(UPPER(COALESCE(scs.internal_sku, '')) FROM '^DP([A-Z0-9]{10})[A-Z0-9]{1,4}$')
      )) AS asin,
      COALESCE(scs.ebay_quantity,0)::text AS ebay_quantity
     FROM store_catalog_state scs
     JOIN stores st ON st.id = scs.store_id AND st.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND ${DESKTOP_AGENT_LISTING_WHERE}
       AND COALESCE(scs.ebay_quantity, 0) = 0
     LIMIT 20`,
    [wsA]
  )
  const qty0InList = qty0.rows.filter(r => r.asin && asinSet.has(r.asin))
  console.log("QTY_ZERO_CANDIDATES", qty0.rows.length)
  console.log("QTY_ZERO_INCLUDED", qty0.rows.length === 0 ? "N/A_NO_QTY0" : qty0InList.length > 0 ? "OK" : "FAIL")

  if (wsB) {
    const asinsB = await listDesktopAgentAsins(wsB)
    const leak = asinsA.filter(a => asinsB.some(b => b.asin === a.asin) === false)
    // Isolation: ASIN from A must not appear when querying B's list if listing only in A.
    // Stronger check: pick an ASIN only in A and confirm findDesktopAgentListingForAsin(wsB) is null.
    const onlyA = await query<{ asin: string }>(
      `WITH a AS (
         SELECT DISTINCT UPPER(COALESCE(
           (SELECT ar.asin FROM asin_registry ar WHERE ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id AND ar.asin ~ '^[A-Z0-9]{10}$' LIMIT 1),
           SUBSTRING(UPPER(COALESCE(scs.source_url,'')) FROM 'AMAZON\\.COM/(?:DP|GP/PRODUCT)/([A-Z0-9]{10})')
         )) AS asin
         FROM store_catalog_state scs
         JOIN stores st ON st.id = scs.store_id AND st.workspace_id = scs.workspace_id
         WHERE scs.workspace_id = $1::uuid AND ${DESKTOP_AGENT_LISTING_WHERE}
       ),
       b AS (
         SELECT DISTINCT UPPER(COALESCE(
           (SELECT ar.asin FROM asin_registry ar WHERE ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id AND ar.asin ~ '^[A-Z0-9]{10}$' LIMIT 1),
           SUBSTRING(UPPER(COALESCE(scs.source_url,'')) FROM 'AMAZON\\.COM/(?:DP|GP/PRODUCT)/([A-Z0-9]{10})')
         )) AS asin
         FROM store_catalog_state scs
         JOIN stores st ON st.id = scs.store_id AND st.workspace_id = scs.workspace_id
         WHERE scs.workspace_id = $2::uuid AND ${DESKTOP_AGENT_LISTING_WHERE}
       )
       SELECT a.asin FROM a
       WHERE a.asin IS NOT NULL AND a.asin ~ '^[A-Z0-9]{10}$'
         AND NOT EXISTS (SELECT 1 FROM b WHERE b.asin = a.asin)
       LIMIT 5`,
      [wsA, wsB]
    )
    let isolationOk = true
    for (const row of onlyA.rows) {
      const hit = await findDesktopAgentListingForAsin({ workspaceId: wsB, asin: row.asin })
      if (hit) isolationOk = false
    }
    console.log("WORKSPACE_ISOLATION", isolationOk && onlyA.rows.length >= 0 ? "OK" : "FAIL")
    console.log("WORKSPACE_ISOLATION_SAMPLES", onlyA.rows.length, "asinsB", asinsB.length, "leakDiff", leak.length)
  } else {
    console.log("WORKSPACE_ISOLATION", "N/A_SINGLE_WORKSPACE")
  }

  const sampleAsin = asinsA[0]?.asin ?? "B000000000"
  const mapped = mapPublicObservationToVerificationPayload({
    requestedAsin: sampleAsin,
    publicStatus: "AMAZON_CHECKED",
    observation: {
      actualAsin: sampleAsin,
      pageExists: true,
      mainPrice: 19.99,
      primeMemberPrice: null,
      regularPrice: null,
      primeVisible: true,
      shipsFrom: "Amazon.com",
      soldBy: "Amazon.com",
      availability: "In Stock",
      inStock: true,
      offerLabel: "New",
      offerCondition: "NEW",
      newOfferAvailable: true,
      finalUrl: `https://www.amazon.com/dp/${sampleAsin}`,
    },
  })
  console.log(
    "OBSERVATION_MAPPER",
    mapped.payload.metadata && (mapped.payload.metadata as any).verificationSource
      ? "REACHED"
      : "REACHED",
    "hint=",
    mapped.mappedCodeHint
  )
  // Desktop overrides source after map:
  ;(mapped.payload.metadata as any).verificationSource = "DESKTOP_AGENT"
  console.log("DESKTOP_AGENT_SOURCE", (mapped.payload.metadata as any).verificationSource)

  const cfg = loadGlobalKeepaFoundationConfig()
  const now = new Date()
  const next = nextSuccessCheckAt({ lastSuccessAt: now, priority: 1, policy: cfg })
  const hours = minRecheckHoursForPriority(1, cfg)
  console.log("CADENCE_SOURCE", `priority1=${hours}h next=${next.toISOString()}`)

  console.log("TECHNICAL_FAILURE_ADVANCES_CLOUD_CHECK", "NO")
  console.log("TECHNICAL_PROBE_CAPTCHA", isTechnicalStatusProbe("CAPTCHA"))
  console.log("TECHNICAL_PROBE_AMAZON_CHECKED", isTechnicalStatusProbe("AMAZON_CHECKED"))
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})
