"use client"

import Link from "next/link"
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import type { AppStoreSummary } from "@/lib/userAppClient"
import "./dashboard-ops.css"

export type DashTone = "positive" | "warning" | "critical" | "info" | "neutral"

export const dashCard: CSSProperties = {
  padding: "12px 16px",
  borderRadius: 12,
  border: "1px solid #3A4658",
  background: "#171E2A",
}

export function moneyUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US")
}

export function DashboardStoreSelect({
  stores,
  value,
  onChange,
}: {
  stores: AppStoreSummary[]
  value: string
  onChange: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selectedStore = stores.find(s => String(s.storeId) === value)
  const label =
    value === "all"
      ? "All stores"
      : selectedStore
        ? `${selectedStore.storeCode} — ${selectedStore.name}`
        : "All stores"

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const options: { id: string; label: string }[] = [
    { id: "all", label: "All stores" },
    ...stores.map(store => ({
      id: String(store.storeId),
      label: `${store.storeCode} — ${store.name}`,
    })),
  ]

  return (
    <div className={`dash-ops-selector${open ? " dash-ops-selector--open" : ""}`} ref={rootRef}>
      <span className="dash-ops-dot dash-ops-dot--positive" aria-hidden="true" />
      <button
        type="button"
        className="dash-ops-selector-trigger"
        aria-label="Dashboard store scope"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span className="dash-ops-selector-label">{label}</span>
        <span className="dash-ops-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="dash-ops-selector-menu" role="listbox" aria-label="Dashboard store scope">
          {options.map(option => {
            const active = option.id === value
            return (
              <li key={option.id} role="option" aria-selected={active}>
                <button
                  type="button"
                  className={`dash-ops-selector-option${active ? " dash-ops-selector-option--selected" : ""}`}
                  onClick={() => {
                    onChange(option.id)
                    setOpen(false)
                  }}
                >
                  {active ? <span className="dash-ops-dot dash-ops-dot--positive" aria-hidden="true" /> : <span className="dash-ops-selector-option-gap" aria-hidden="true" />}
                  {option.label}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function DashboardSection({
  title,
  action,
  children,
  variant,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  variant?: "finance" | "attn"
}) {
  const extra = variant === "finance" ? " dash-ops-section--finance" : variant === "attn" ? " dash-ops-section--attn" : ""
  return (
    <section className={`dash-ops-section${extra}`}>
      <div className="dash-ops-section__head">
        <h2 className="dash-ops-section__title">{title}</h2>
        {action ?? null}
      </div>
      <div className="dash-ops-section__body">{children}</div>
    </section>
  )
}

export function DashboardKpiCard({
  label,
  value,
  hint,
  delta,
  tone = "positive",
  icon,
}: {
  label: string
  value: string
  hint?: string
  delta?: string
  tone?: "positive" | "warning"
  icon: ReactNode
}) {
  return (
    <div className={`dash-ops-kpi${tone === "warning" ? " dash-ops-kpi--warning" : ""}`}>
      <div className="dash-ops-kpi__top">
        <span className="dash-ops-kpi__icon">{icon}</span>
        <span className="dash-ops-kpi__label">{label}</span>
      </div>
      <div className="dash-ops-kpi__value">{value}</div>
      {delta || hint ? (
        <div className="dash-ops-kpi__meta">
          {delta ? <span className="dash-ops-kpi__delta">{delta}</span> : null}
          {hint ? <span className="dash-ops-kpi__hint">{hint}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

export function DashboardStatusBadge({
  severity,
  children,
}: {
  severity: "high" | "medium" | "low" | "neutral" | DashTone
  children: ReactNode
}) {
  const tone = severityToTone(severity)
  return (
    <span className={`dash-ops-pill dash-ops-pill--${tone}`}>
      <span className={`dash-ops-dot dash-ops-dot--${tone}`} />
      {children}
    </span>
  )
}

export function DashboardMetric({
  label,
  value,
  hint,
  valueTone,
}: {
  label: string
  value: string
  hint?: string
  valueTone?: "green" | "amber"
}) {
  const valueClass =
    valueTone === "green"
      ? "dash-ops-metric__value dash-ops-metric__value--green"
      : valueTone === "amber"
        ? "dash-ops-metric__value dash-ops-metric__value--amber"
        : "dash-ops-metric__value"
  return (
    <div className="dash-ops-metric">
      <div className="dash-ops-metric__label">{label}</div>
      <div className={valueClass}>{value}</div>
      {hint ? <div className="dash-ops-metric__hint">{hint}</div> : null}
    </div>
  )
}

export function MiniSparkline({ points }: { points?: number[] }) {
  if (!points || points.length < 2) return null
  return null
}

export function DashboardTable({
  columns,
  rows,
}: {
  columns: string[]
  rows: Array<Array<ReactNode>>
}) {
  return (
    <div className="dash-ops-table-wrap">
      <table className="dash-ops-table">
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function NeedsAttentionList({
  items,
}: {
  items: Array<{
    id: string
    title: string
    explanation: string
    count: number
    severity: "high" | "medium" | "low"
    href: string | null
  }>
}) {
  if (items.length === 0) {
    return <p className="dash-ops-empty">Nothing needs attention in this scope.</p>
  }
  return (
    <div>
      {items.map(item => {
        const tone = severityToTone(item.severity)
        const body = (
          <>
            <span className={`dash-ops-dot dash-ops-dot--${tone}`} />
            <span className="dash-ops-issue__label">{item.title}</span>
            <span className={`dash-ops-pill dash-ops-pill--${tone}`}>
              <span className={`dash-ops-dot dash-ops-dot--${tone}`} />
              {item.count}
            </span>
          </>
        )
        const cls = `dash-ops-issue${tone === "critical" ? " dash-ops-issue--critical" : ""}`
        return item.href ? (
          <Link key={item.id} href={item.href} className={cls}>
            {body}
          </Link>
        ) : (
          <div key={item.id} className={cls}>
            {body}
          </div>
        )
      })}
    </div>
  )
}

export function RecentActivityList({
  items,
}: {
  items: Array<{ id: string; at: string; title: string; detail: string | null; href: string | null }>
}) {
  const rows = items.slice(0, 6)
  if (rows.length === 0) {
    return <p className="dash-ops-empty">No recent order or message events.</p>
  }
  return (
    <div>
      {rows.map(item => {
        const tone = activityTone(item.title)
        const inner = (
          <>
            <span className={`dash-ops-dot dash-ops-dot--${tone}`} />
            <span className="dash-ops-activity__type">{item.title.replace(/_/g, " ")}</span>
            {item.detail ? <span className="dash-ops-activity__ref">{item.detail}</span> : <span className="dash-ops-activity__ref" />}
            <span className="dash-ops-activity__when">{fmtRelative(item.at)}</span>
          </>
        )
        return item.href ? (
          <Link key={item.id} href={item.href} className="dash-ops-activity__row">
            {inner}
          </Link>
        ) : (
          <div key={item.id} className="dash-ops-activity__row">
            {inner}
          </div>
        )
      })}
    </div>
  )
}

export function OrderPipelineList({
  stages,
}: {
  stages: Array<{ label: string; count: number | undefined; tone: DashTone }>
}) {
  const known = stages.every(s => s.count != null)
  const max = Math.max(0, ...stages.map(s => s.count ?? 0))
  return (
    <div className="dash-ops-pipeline">
      {stages.map(stage => {
        const count = stage.count
        const pct = !known || max === 0 || count == null ? 0 : (count / max) * 100
        const critical = stage.tone === "critical"
        return (
          <div key={stage.label} className={`dash-ops-pipe${critical ? " dash-ops-pipe--critical" : ""}`}>
            <span className={`dash-ops-dot dash-ops-dot--md dash-ops-dot--${stage.tone}`} />
            <span className="dash-ops-pipe__label">{stage.label}</span>
            <div className="dash-ops-track">
              <span style={{ width: `${pct}%`, background: toneHex(stage.tone) }} />
            </div>
            <span className={`dash-ops-pill dash-ops-pill--${stage.tone}`}>
              <span className={`dash-ops-dot dash-ops-dot--${stage.tone}`} />
              {count ?? "—"}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function ListingHealthList({
  health,
}: {
  health: {
    activeListings: number
    outOfStock: number
    stockAlerts: number
    needsAsin: number
  } | null
}) {
  if (!health) {
    return <p className="dash-ops-empty">Listing health unavailable.</p>
  }
  const rows: Array<{
    label: string
    support: string
    count: number
    badge: string
    tone: DashTone
  }> = [
    {
      label: "Active listings",
      support: "Purchasable now",
      count: health.activeListings,
      badge: "Healthy",
      tone: "positive",
    },
    {
      label: "Out of stock",
      support: "Hidden from buyers",
      count: health.outOfStock,
      badge: "Critical",
      tone: "critical",
    },
    {
      label: "Stock alerts",
      support: "Below the watch line",
      count: health.stockAlerts,
      badge: "Watch",
      tone: "warning",
    },
    {
      label: "Needs ASIN",
      support: "Source link missing",
      count: health.needsAsin,
      badge: "Missing",
      tone: "info",
    },
  ]
  return (
    <div>
      <div className="dash-ops-health-head">
        <span>Listing</span>
        <span style={{ flex: 1 }} />
        <span className="dash-ops-health-head__count">Count</span>
        <span style={{ width: 68, flexShrink: 0 }} />
      </div>
      <div className="dash-ops-health-grid">
      {rows.map(row => (
        <div key={row.label} className="dash-ops-health">
          <span className={`dash-ops-dot dash-ops-dot--${row.tone}`} />
          <span className="dash-ops-health__copy">
            <span className="dash-ops-health__title">{row.label}</span>
            <span className="dash-ops-health__sub">{row.support}</span>
          </span>
          <span className={`dash-ops-health__count dash-ops-health__count--${row.tone}`}>{fmtInt(row.count)}</span>
          <DashboardStatusBadge severity={row.tone}>{row.badge}</DashboardStatusBadge>
        </div>
      ))}
      </div>
    </div>
  )
}

export function CustomerServiceSummary({
  cs,
  periodLabel = "Today",
}: {
  cs: {
    sentToday: number
    failed: number
    thankYouToday: number
    shippedToday: number
    delayedToday: number
    deliveredToday: number
  } | null
  periodLabel?: string
}) {
  if (!cs) {
    return <p className="dash-ops-empty">Customer service summary unavailable.</p>
  }
  const rows: Array<{ label: string; count: number; tone: DashTone; group?: boolean }> = [
    { label: `Auto messages sent (${periodLabel})`, count: cs.sentToday, tone: "positive" },
    { label: "Failed sends", count: cs.failed, tone: "critical" },
    { label: "Thank You", count: cs.thankYouToday, tone: "neutral", group: true },
    { label: "Shipped", count: cs.shippedToday, tone: "positive" },
    { label: "Delayed", count: cs.delayedToday, tone: "warning" },
    { label: "Delivered", count: cs.deliveredToday, tone: "positive" },
  ]
  return (
    <div>
      {rows.map(row => (
        <div
          key={row.label}
          className={`dash-ops-issue${row.tone === "critical" ? " dash-ops-issue--critical" : ""}${row.group ? " dash-ops-issue--group" : ""}`}
        >
          <span className={`dash-ops-dot dash-ops-dot--${row.tone}`} />
          <span className="dash-ops-issue__label">{row.label}</span>
          <span className={`dash-ops-pill dash-ops-pill--${row.tone}`}>
            <span className={`dash-ops-dot dash-ops-dot--${row.tone}`} />
            {row.count}
          </span>
        </div>
      ))}
    </div>
  )
}

export function KpiBarsIcon({ color = "#3DDC97" }: { color?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="11" width="11" height="1.6" rx="0.8" fill={color} />
      <rect x="2.5" y="7.2" width="11" height="1.6" rx="0.8" fill={color} />
      <rect x="2.5" y="3.4" width="7.5" height="1.6" rx="0.8" fill={color} />
    </svg>
  )
}

export function KpiWarnIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 3.2 13.4 12.6H2.6L8 3.2Z"
        fill="none"
        stroke="#E8B04A"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <rect x="7.35" y="6.6" width="1.3" height="3.2" rx="0.4" fill="#E8B04A" />
      <rect x="7.35" y="10.4" width="1.3" height="1.3" rx="0.4" fill="#E8B04A" />
    </svg>
  )
}

function severityToTone(severity: "high" | "medium" | "low" | "neutral" | DashTone): DashTone {
  if (severity === "high") return "critical"
  if (severity === "medium") return "warning"
  if (severity === "low") return "info"
  return severity
}

function toneHex(tone: DashTone): string {
  if (tone === "positive") return "#3DDC97"
  if (tone === "warning") return "#E8B04A"
  if (tone === "critical") return "#F07178"
  if (tone === "info") return "#7EB6FF"
  return "#C5CEDA"
}

function activityTone(title: string): DashTone {
  const t = title.toLowerCase()
  if (/(fail|problem|cancel|error|refund)/.test(t)) return "critical"
  if (/(delay|missing|assist)/.test(t)) return "warning"
  if (/(deliver|ship|confirm)/.test(t)) return "positive"
  if (/(cs |customer service)/.test(t)) return "neutral"
  return "info"
}

function fmtRelative(s: string): string {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const sec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${Math.round(sec / 3600)}h`
  return `${Math.round(sec / 86400)}d`
}
