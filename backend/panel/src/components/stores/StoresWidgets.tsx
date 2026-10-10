"use client"

import Link from "next/link"
import type { ReactNode } from "react"
import type { AppStoreSummary } from "@/lib/userAppTypes"
import "./stores-page.css"

export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US")
}

export function fmtTokenStamp(s: string | null | undefined): string | null {
  if (!s?.trim()) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function StoreKpiCard({
  label,
  value,
  hint,
  tone = "green",
  icon,
}: {
  label: string
  value: string
  hint: string
  tone?: "green" | "warn" | "muted"
  icon: ReactNode
}) {
  return (
    <div className={`lj-stores-kpi${tone === "warn" ? " lj-stores-kpi--warn" : ""}`}>
      <div className="lj-stores-kpi-top">
        <span
          className={`lj-stores-kpi-well lj-stores-kpi-well--${tone === "warn" ? "amber" : tone === "muted" ? "muted" : "green"}`}
          aria-hidden="true"
        >
          {icon}
        </span>
        <span className="lj-stores-kpi-label">{label}</span>
      </div>
      <div className={`lj-stores-kpi-value${tone === "warn" ? " lj-stores-kpi-value--amber" : ""}`}>{value}</div>
      <div className="lj-stores-kpi-hint">{hint}</div>
    </div>
  )
}

export function KpiStoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2.5 6.5 8 3l5.5 3.5V13a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V6.5Z" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.5 14V9h3v5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export function KpiListIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export function KpiCheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.6 8.2 7.2 9.8 10.5 6.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function KpiWarnIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 2.6 14.2 13.4H1.8L8 2.6Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 6.6v3.2M8 11.6h.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export function KpiBellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 2.8a3.6 3.6 0 0 0-3.6 3.6c0 2.4-1 3.4-1 3.4h9.2s-1-1-1-3.4A3.6 3.6 0 0 0 8 2.8Z" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.6 12.6a1.4 1.4 0 0 0 2.8 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function connectionLine(store: AppStoreSummary): string {
  const health =
    store.connectionHint === "reconnect_suggested"
      ? "Reconnect suggested"
      : store.connected
        ? "Connection healthy"
        : "Not connected"
  const stamp = fmtTokenStamp(store.ebayExpiresAt)
  return stamp ? `${health}  ·  token expires ${stamp}` : health
}

function asinHref(store: AppStoreSummary): string {
  const code = encodeURIComponent(store.storeCode)
  if (store.listingCount === 0) return `/app/import?storeCode=${code}`
  return `/app/import?storeCode=${code}&mode=asin-match`
}

export function StoreCard({ store }: { store: AppStoreSummary }) {
  const initial = (store.name.trim().charAt(0) || store.storeCode.charAt(0) || "?").toUpperCase()
  const pct = Number.isFinite(store.asinCompletionPercent) ? Math.max(0, Math.min(100, store.asinCompletionPercent)) : 0
  const code = encodeURIComponent(store.storeCode)

  return (
    <article className="lj-stores-card">
      <div className="lj-stores-card-head">
        <span className="lj-stores-avatar" aria-hidden="true">{initial}</span>
        <div className="lj-stores-id">
          <div className="lj-stores-name" title={store.name}>{store.name}</div>
          <div className="lj-stores-code">{store.storeCode}</div>
        </div>
        <span className={`lj-stores-badge${store.connected ? "" : " lj-stores-badge--off"}`}>
          <span className="lj-stores-badge-dot" aria-hidden="true" />
          {store.connected ? "Connected" : "Not connected"} · {store.status}
        </span>
      </div>

      <p className="lj-stores-conn">{connectionLine(store)}</p>

      <div className="lj-stores-tiles">
        <div className="lj-stores-tile">
          <span className="lj-stores-tile-label">Listings</span>
          <span className="lj-stores-tile-value">{fmtInt(store.listingCount)}</span>
        </div>
        <div className="lj-stores-tile">
          <span className="lj-stores-tile-label">Pending alerts</span>
          <span className={`lj-stores-tile-value${store.stockAlertsCount === 0 ? " lj-stores-tile-value--muted" : ""}`}>
            {fmtInt(store.stockAlertsCount)}
          </span>
        </div>
      </div>

      <div className="lj-stores-asin">
        <div className="lj-stores-asin-head">
          <span className="lj-stores-asin-title">ASIN Linking</span>
          <span className="lj-stores-asin-pct">{store.asinCompletionPercent}%</span>
        </div>
        <div className="lj-stores-track" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="lj-stores-asin-stats">
          <div className="lj-stores-asin-stat">
            <span className="lj-stores-asin-stat-label">Linked</span>
            <span className="lj-stores-asin-stat-value lj-stores-asin-stat-value--green">{fmtInt(store.asinLinkedCount)}</span>
          </div>
          <div className="lj-stores-asin-stat">
            <span className="lj-stores-asin-stat-label">Needs ASIN</span>
            <span className="lj-stores-asin-stat-value lj-stores-asin-stat-value--amber">{fmtInt(store.needsAsinCount)}</span>
          </div>
          <div className="lj-stores-asin-stat">
            <span className="lj-stores-asin-stat-label">Completion</span>
            <span className="lj-stores-asin-stat-value lj-stores-asin-stat-value--green">{store.asinCompletionPercent}%</span>
          </div>
        </div>
        {store.listingCount === 0 ? (
          <Link href={asinHref(store)} className="lj-stores-link-asins">
            Import Listings
          </Link>
        ) : store.needsAsinCount > 0 ? (
          <Link href={asinHref(store)} className="lj-stores-link-asins">
            Link ASINs
          </Link>
        ) : (
          <span className="lj-stores-all-linked">All linked</span>
        )}
      </div>

      <div className="lj-stores-actions">
        <Link href={`/app/import?storeCode=${code}`} className="lj-stores-action">Import Listings</Link>
        <Link href={`/app/listings?storeCode=${code}`} className="lj-stores-action">View Listings</Link>
        <Link href={`/app/settings?storeCode=${code}`} className="lj-stores-action">Settings</Link>
        <Link href={`/app/stock-alerts?storeCode=${code}`} className="lj-stores-action">Stock Alerts</Link>
      </div>
    </article>
  )
}
