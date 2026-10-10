import { createHash } from "crypto"

export type KeepaReconcileRow = {
  asin: string
  status: string
  priority: string
  cadenceHours: number
  activeConsumerCount: number
  sourceVersion: number
}

export type KeepaReconcileManifest = {
  hash: string
  uniqueAsins: number
  active: number
  pausedQtyZero: number
  sold: number
  standard: number
  duplicates: number
  sourceVersionRegressions: number
}

export function normalizeKeepaReconcileLine(row: KeepaReconcileRow): string {
  return [
    String(row.asin ?? "").trim().toUpperCase(),
    String(row.status ?? ""),
    String(row.priority ?? ""),
    String(Number(row.cadenceHours) || 0),
    String(Number(row.activeConsumerCount) || 0),
    String(Number(row.sourceVersion) || 0),
  ].join("|")
}

export function computeKeepaReconcileManifest(rows: KeepaReconcileRow[]): KeepaReconcileManifest {
  const included = rows
    .map(r => ({
      asin: String(r.asin ?? "").trim().toUpperCase(),
      status: String(r.status ?? ""),
      priority: String(r.priority ?? ""),
      cadenceHours: Number(r.cadenceHours) || 0,
      activeConsumerCount: Number(r.activeConsumerCount) || 0,
      sourceVersion: Number(r.sourceVersion) || 0,
    }))
    .filter(r => r.status === "ACTIVE" || r.status === "PAUSED_QTY_ZERO")
    .sort((a, b) => (a.asin < b.asin ? -1 : a.asin > b.asin ? 1 : 0))

  const seen = new Map<string, number>()
  let duplicates = 0
  let sourceVersionRegressions = 0
  for (const row of included) {
    const prev = seen.get(row.asin)
    if (prev != null) {
      duplicates++
      if (row.sourceVersion < prev) sourceVersionRegressions++
    }
    seen.set(row.asin, row.sourceVersion)
  }

  const unique = included.filter((row, i) => i === 0 || row.asin !== included[i - 1].asin)
  const body = unique.map(normalizeKeepaReconcileLine).join("\n")
  return {
    hash: createHash("sha256").update(body).digest("hex"),
    uniqueAsins: unique.length,
    active: unique.filter(r => r.status === "ACTIVE").length,
    pausedQtyZero: unique.filter(r => r.status === "PAUSED_QTY_ZERO").length,
    sold: unique.filter(r => r.status === "ACTIVE" && r.priority === "SOLD").length,
    standard: unique.filter(r => r.status === "ACTIVE" && r.priority === "STANDARD").length,
    duplicates,
    sourceVersionRegressions,
  }
}

export function reconcileManifestsMatch(a: KeepaReconcileManifest, b: KeepaReconcileManifest): boolean {
  return (
    a.hash === b.hash &&
    a.uniqueAsins === b.uniqueAsins &&
    a.active === b.active &&
    a.pausedQtyZero === b.pausedQtyZero &&
    a.sold === b.sold &&
    a.standard === b.standard &&
    a.duplicates === 0 &&
    b.duplicates === 0 &&
    a.sourceVersionRegressions === 0 &&
    b.sourceVersionRegressions === 0
  )
}
