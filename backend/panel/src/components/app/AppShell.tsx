"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { fetchAuthMe, logoutUser, type UserPublic } from "@/lib/userAuthClient"
import { fetchAppDashboard, fetchAppActivityUnread, fetchAppActivityFeed, markAppActivityRead } from "@/lib/userAppClient"
import ExtensionLocalWorkerBridge from "@/components/layout/ExtensionLocalWorkerBridge"
import { AppStoreSelectionProvider } from "@/lib/appStoreSelection"
import PasswordSetupModal from "@/components/auth/PasswordSetupModal"
import { IconBolt, IconChat, IconMail, navIconForHref } from "@/components/app/sidebar-icons"
import "./app-shell-sidebar.css"

const BARE_PATHS = ["/app/login", "/login", "/register"]

export const APP_NAV_ITEMS = [
  { href: "/app/dashboard",    label: "Dashboard",    hint: "Overview" },
  { href: "/app/stores",       label: "Stores",       hint: "eBay accounts" },
  { href: "/app/import",       label: "Import",       hint: "Sync listings" },
  { href: "/app/listings",     label: "Listings",     hint: "Monitor products" },
  { href: "/app/orders",            label: "Siparişler",        hint: "eBay siparişleri" },
  { href: "/app/customer-service",  label: "Customer Service",  hint: "Buyer messages" },
  { href: "/app/stock-alerts",      label: "Stock Alerts",      hint: "Review risks" },
  { href: "/app/stock-guard",  label: "Stock Guard",  hint: "Guard settings" },
  { href: "/app/activity",     label: "Activity",     hint: "Action history" },
  { href: "/app/settings",     label: "Settings",     hint: "Store configuration" },
] as const

export const APP_ADMIN_NAV_ITEMS = [
  { href: "/app/admin/amazon-worker",  label: "Amazon Kaynak Kontrol", hint: "Keepa, Oxylabs, eBay kuralları" },
  { href: "/app/admin/users",          label: "Pending Users",     hint: "Approve registrations" },
] as const

export function isAppNavActive(pathname: string, href: string): boolean {
  const path = pathname.split("?")[0] ?? ""
  if (href === "/app/dashboard") {
    return path === "/app/dashboard" || path === "/app"
  }
  return path === href || path.startsWith(`${href}/`)
}

function isCsPath(pathname: string): boolean {
  const path = pathname.split("?")[0] ?? ""
  return path === "/app/customer-service" || path.startsWith("/app/customer-service/")
}

function isCsAutomationsPath(pathname: string): boolean {
  const path = pathname.split("?")[0] ?? ""
  return path === "/app/customer-service" || path === "/app/customer-service/automations"
}

function isCsMessagesPath(pathname: string): boolean {
  const path = pathname.split("?")[0] ?? ""
  return path === "/app/customer-service/messages" || path.startsWith("/app/customer-service/messages/")
}

function isActiveAdmin(user: UserPublic | null): boolean {
  return !!user && user.role === "admin" && user.approvalStatus === "active"
}

type HeaderSummary = {
  stores:   number
  listings: number
  alerts:   number
}

type AppShellProps = {
  children: ReactNode
}

export default function AppShell({ children }: AppShellProps) {
  const pathname = usePathname() ?? ""
  const bare = BARE_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`))
  const [user, setUser] = useState<UserPublic | null>(null)

  useEffect(() => {
    if (bare) return
    let cancelled = false
    void (async () => {
      const me = await fetchAuthMe()
      if (!cancelled) setUser(me)
    })()
    return () => {
      cancelled = true
    }
  }, [bare])

  if (bare) {
    return <>{children}</>
  }

  const showAdmin = isActiveAdmin(user)
  const needsPasswordSetup = Boolean(user?.needsPasswordSetup)

  return (
    <AppStoreSelectionProvider>
    <div className="app-shell">
      {needsPasswordSetup && user && (
        <PasswordSetupModal
          email={user.email}
          onDone={() => setUser((u) => (u ? { ...u, needsPasswordSetup: false } : u))}
        />
      )}
      <ExtensionLocalWorkerBridge />
      <aside className="app-shell-sidebar" aria-label="User app navigation">
        <div className="app-shell-brand">
          <span className="app-shell-brand-title">ListJetGo eBay</span>
          <span className="app-shell-brand-sub">Seller workspace</span>
        </div>
        <nav className="app-shell-nav">
          {APP_NAV_ITEMS.map(item =>
            item.href === "/app/customer-service" ? (
              <CustomerServiceNav key={item.href} item={item} pathname={pathname} />
            ) : (
              <AppNavLink key={item.href} item={item} pathname={pathname} />
            )
          )}
          {showAdmin && (
            <>
              <div className="app-shell-nav-admin-gap" aria-hidden="true" />
              <p className="app-shell-nav-section">ADMIN</p>
              {APP_ADMIN_NAV_ITEMS.map(item => (
                <AppNavLink key={item.href} item={item} pathname={pathname} />
              ))}
            </>
          )}
        </nav>
        <div className="app-shell-nav-spacer" aria-hidden="true" />
        <div className="app-shell-help">
          <div className="app-shell-help-card">
            <p className="app-shell-help-label">Need help?</p>
            <p className="app-shell-help-text">Follow the checklist on Dashboard.</p>
            <Link href="/app/dashboard" className="app-shell-help-link">
              Dashboard
            </Link>
          </div>
        </div>
      </aside>

      <div className="app-shell-main-wrap">
        <AppShellHeader user={user} />

        <nav className="app-shell-mobile-nav" aria-label="User app navigation mobile">
          {APP_NAV_ITEMS.map(item => {
            const active = isAppNavActive(pathname, item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`app-shell-mobile-link${active ? " app-shell-mobile-link--active" : ""}`}
              >
                {item.label}
              </Link>
            )
          })}
          {isAppNavActive(pathname, "/app/customer-service") && (
            <>
              <Link
                href="/app/customer-service"
                className={`app-shell-mobile-link${isCsAutomationsPath(pathname) ? " app-shell-mobile-link--active" : ""}`}
              >
                Automations
              </Link>
              <Link
                href="/app/customer-service/messages"
                className={`app-shell-mobile-link${isCsMessagesPath(pathname) ? " app-shell-mobile-link--active" : ""}`}
              >
                Buyer Messages
              </Link>
            </>
          )}
          {showAdmin &&
            APP_ADMIN_NAV_ITEMS.map(item => {
              const active = isAppNavActive(pathname, item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`app-shell-mobile-link${active ? " app-shell-mobile-link--active" : ""}`}
                >
                  {item.label}
                </Link>
              )
            })}
        </nav>

        <main className="app-shell-content">{children}</main>
      </div>
    </div>
    </AppStoreSelectionProvider>
  )
}

function AppShellHeader({ user }: { user: UserPublic | null }) {
  const [summary, setSummary] = useState<HeaderSummary | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!user) {
        setSummary(null)
        return
      }
      const dash = await fetchAppDashboard()
      if (cancelled) return
      if (dash.ok) {
        setSummary({
          stores:   dash.data.summary.storeCount,
          listings: dash.data.summary.listingCount,
          alerts:   dash.data.summary.pendingStockAlerts,
        })
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [user])

  const handleLogout = useCallback(async () => {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await logoutUser()
    } catch {
      setLoggingOut(false)
    }
  }, [loggingOut])

  const email = user?.email?.trim() || "User"

  return (
    <header className="app-shell-header">
      <div className="app-shell-header-spacer" aria-hidden="true" />

      <div className="app-shell-header-actions">
        {summary && (
          <div className="app-shell-summary-chips" aria-label="Workspace summary">
            <span className="app-shell-chip">Stores: {summary.stores}</span>
            <span className="app-shell-chip">Listings: {summary.listings}</span>
            <span className="app-shell-chip">Alerts: {summary.alerts}</span>
          </div>
        )}

        <ActivityBell />

        <div className="app-shell-user-block">
          <span className="app-shell-header-label">eBay Panel</span>
          <span className="app-shell-user-email" title={email}>
            {email}
          </span>
        </div>

        <button
          type="button"
          className="app-shell-logout-btn"
          onClick={() => void handleLogout()}
          disabled={loggingOut}
        >
          {loggingOut ? "Signing out…" : "Logout"}
        </button>
      </div>
    </header>
  )
}

function ActivityBell() {
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [items, setItems] = useState<Array<{ id: number; title: string; message: string; created_at: string; asin: string | null }>>([])

  const load = useCallback(async () => {
    const u = await fetchAppActivityUnread()
    if (u.ok) setUnread(u.data.unread)
  }, [])

  useEffect(() => {
    void load()
    const t = window.setInterval(() => void load(), 20000)
    return () => window.clearInterval(t)
  }, [load])

  const toggle = useCallback(async () => {
    const next = !open
    setOpen(next)
    if (next) {
      const feed = await fetchAppActivityFeed()
      if (feed.ok) setItems(feed.data.items.slice(0, 12).map(i => ({
        id: i.id,
        title: i.title,
        message: i.message,
        created_at: i.created_at,
        asin: i.asin,
      })))
    }
  }, [open])

  return (
    <div className="app-activity-bell">
      <button type="button" className="app-activity-bell-btn" onClick={() => void toggle()} aria-label="Notifications">
        🔔{unread > 0 ? <span className="app-activity-bell-badge">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      {open && (
        <div className="app-activity-popover" role="dialog" aria-label="Recent activity">
          <div className="app-activity-popover-head">
            <strong>Last 24 hours</strong>
            {unread > 0 && (
              <button type="button" className="app-activity-mark" onClick={() => void markAppActivityRead("all").then(() => { setUnread(0); void load() })}>
                Mark read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="app-activity-empty">No recent activity</p>
          ) : (
            <ul className="app-activity-list">
              {items.map(item => (
                <li key={item.id}>
                  <div className="app-activity-title">{item.title}</div>
                  <div className="app-activity-msg">{item.message}</div>
                </li>
              ))}
            </ul>
          )}
          <Link href="/app/activity" className="app-activity-all" onClick={() => setOpen(false)}>View all</Link>
        </div>
      )}
    </div>
  )
}

function AppNavLink({
  item,
  pathname,
}: {
  item: (typeof APP_NAV_ITEMS)[number] | (typeof APP_ADMIN_NAV_ITEMS)[number]
  pathname: string
}) {
  const active = isAppNavActive(pathname, item.href)
  const Icon = navIconForHref(item.href)
  return (
    <Link
      href={item.href}
      className={`app-shell-nav-link${active ? " app-shell-nav-link--active" : ""}`}
      title={item.hint}
    >
      <Icon className="app-shell-nav-icon" />
      <span className="app-shell-nav-label">{item.label}</span>
    </Link>
  )
}

function NavCaret({ open }: { open: boolean }) {
  return (
    <span className="app-shell-nav-caret" aria-hidden="true">
      {open ? (
        <svg width="8" height="11" viewBox="0 0 8 11" fill="currentColor">
          <path d="M1 3.4h6L4 8.2 1 3.4z" />
        </svg>
      ) : (
        <svg width="8" height="11" viewBox="0 0 8 11" fill="currentColor">
          <path d="M2.2 2.1v6.8L6.6 5.5 2.2 2.1z" />
        </svg>
      )}
    </span>
  )
}

function CustomerServiceNav({
  item,
  pathname,
}: {
  item: (typeof APP_NAV_ITEMS)[number]
  pathname: string
}) {
  const onCs = isCsPath(pathname)
  const [open, setOpen] = useState(onCs)

  useEffect(() => {
    if (onCs) setOpen(true)
  }, [onCs])

  return (
    <div className="app-shell-nav-group">
      <Link
        href="/app/customer-service"
        className="app-shell-nav-link"
        title={item.hint}
        onClick={e => {
          if (onCs) {
            e.preventDefault()
            setOpen(v => !v)
          }
        }}
      >
        <IconChat className="app-shell-nav-icon" />
        <span className="app-shell-nav-label">{item.label}</span>
        <NavCaret open={open} />
      </Link>
      {open && (
        <div className="app-shell-nav-sub">
          <Link
            href="/app/customer-service"
            className={`app-shell-nav-link app-shell-nav-link--sub${isCsAutomationsPath(pathname) ? " app-shell-nav-link--active" : ""}`}
          >
            <IconBolt className="app-shell-nav-icon" />
            <span className="app-shell-nav-label">Automations</span>
          </Link>
          <Link
            href="/app/customer-service/messages"
            className={`app-shell-nav-link app-shell-nav-link--sub${isCsMessagesPath(pathname) ? " app-shell-nav-link--active" : ""}`}
          >
            <IconMail className="app-shell-nav-icon" />
            <span className="app-shell-nav-label">Buyer Messages</span>
          </Link>
        </div>
      )}
    </div>
  )
}
