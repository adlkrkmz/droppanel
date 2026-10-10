"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

const NAV = [
  { href: "/scan", label: "Scan", icon: "▪" },
  { href: "/pool", label: "Pool", icon: "▪" },
  { href: "/settings", label: "Settings", icon: "▪" },
]

const LISTINGS_NAV = [
  { href: "/listings/my-listings", label: "My Listings" },
  { href: "/listings/import", label: "Import Listings" },
  { href: "/app/stock-alerts", label: "Stock Alerts" },
  { href: "/orders", label: "Siparişler" },
  { href: "/listings/stock-guard-settings", label: "Stock Guard" },
  { href: "/admin/platform/amazon-worker", label: "Amazon Kaynak Kontrol" },
  { href: "/admin/users/pending", label: "Pending Users" },
]

function isListingsActive(path: string): boolean {
  return (
    path === "/monitor" ||
    path.startsWith("/listings/") ||
    path.startsWith("/monitor/") ||
    path.startsWith("/admin/")
  )
}

export default function Sidebar() {
  const path = usePathname()
  const listingsOpen = isListingsActive(path)

  const linkStyle = (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "8px 12px",
    borderRadius: 4,
    fontSize: 13,
    fontFamily: "'DM Sans', sans-serif",
    fontWeight: active ? 500 : 400,
    letterSpacing: "0.01em",
    background: active ? "rgba(0,255,136,0.07)" : "transparent",
    color: active ? "var(--accent)" : "var(--sub)",
    borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
    textDecoration: "none",
    transition: "all 0.15s",
  })

  return (
    <aside
      className="admin-dashboard-sidebar"
      aria-label="Admin navigation"
    >
      <div
        className="flex items-center gap-2 px-5 py-5"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <span
          className="text-xs font-mono font-semibold tracking-widest uppercase"
          style={{ color: "var(--accent)" }}
        >
          DP
        </span>
        <span
          className="text-sm font-display font-bold tracking-tight"
          style={{ color: "var(--text)", fontFamily: "'Syne', sans-serif" }}
        >
          ListPanel
        </span>
      </div>

      <nav className="flex-1 px-3 py-4 flex flex-col gap-1">
        {NAV.slice(0, 2).map(({ href, label, icon }) => {
          const active = path === href || path.startsWith(href + "/")
          return (
            <Link key={href} href={href} style={linkStyle(active)}>
              <span style={{ color: active ? "var(--accent)" : "var(--dim)", opacity: active ? 1 : 0.6, fontSize: 12 }}>
                {icon}
              </span>
              {label}
            </Link>
          )
        })}

        {/* Listings group */}
        <div style={{ marginTop: 4, marginBottom: 4 }}>
          <p
            style={{
              padding: "8px 12px 4px",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: listingsOpen ? "var(--accent)" : "var(--dim)",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            Listings
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingLeft: 8 }}>
            {LISTINGS_NAV.map(({ href, label }) => {
              const active =
                path === href ||
                (href === "/listings/my-listings" && path === "/monitor")
              return (
                <Link key={href} href={href} style={linkStyle(active)}>
                  <span style={{ width: 12 }} />
                  {label}
                </Link>
              )
            })}
          </div>
        </div>

        {NAV.slice(2).map(({ href, label, icon }) => {
          const active = path === href || path.startsWith(href + "/")
          return (
            <Link key={href} href={href} style={linkStyle(active)}>
              <span style={{ color: active ? "var(--accent)" : "var(--dim)", opacity: active ? 1 : 0.6, fontSize: 12 }}>
                {icon}
              </span>
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="px-5 py-4" style={{ borderTop: "1px solid var(--border)" }}>
        <p className="text-xs font-mono" style={{ color: "var(--dim)" }}>
          v0.1.0-mvp
        </p>
        <p className="text-xs mt-0.5" style={{ color: "var(--dim)" }}>
          single-user mode
        </p>
      </div>
    </aside>
  )
}
