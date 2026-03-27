"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

const NAV = [
  { href: "/import",    label: "Import",      icon: "▪" },
  { href: "/dashboard", label: "Dashboard",  icon: "▪" },
  { href: "/queue",     label: "Queue",       icon: "▪" },
  { href: "/history",   label: "History",     icon: "▪" },
  { href: "/settings",  label: "Settings",    icon: "▪" },
  { href: "/monitor",   label: "Monitor",     icon: "▪" },
  { href: "/pool",      label: "Pool",        icon: "▪" },
  { href: "/dispatch",  label: "Dispatch",    icon: "▪" },
]

export default function Sidebar() {
  const path = usePathname()

  return (
    <aside
      className="fixed top-0 left-0 h-screen w-52 flex flex-col z-20"
      style={{
        background: "var(--surface)",
        borderRight: "1px solid var(--border)",
      }}
    >
      {/* Logo */}
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

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 flex flex-col gap-1">
        {NAV.map(({ href, label, icon }) => {
          const active = path === href || path.startsWith(href + "/")
          return (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-3 px-3 py-2.5 rounded-sm text-sm transition-all duration-150"
              style={{
                background:    active ? "rgba(0,255,136,0.07)" : "transparent",
                color:         active ? "var(--accent)"         : "var(--sub)",
                borderLeft:    active ? "2px solid var(--accent)" : "2px solid transparent",
                fontFamily:    "'DM Sans', sans-serif",
                fontWeight:    active ? 500 : 400,
                letterSpacing: "0.01em",
              }}
            >
              <span
                className="text-xs"
                style={{
                  color:   active ? "var(--accent)" : "var(--dim)",
                  opacity: active ? 1 : 0.6,
                }}
              >
                {icon}
              </span>
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div
        className="px-5 py-4"
        style={{ borderTop: "1px solid var(--border)" }}
      >
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
