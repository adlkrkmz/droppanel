import type { ReactNode } from "react"

type IconProps = { className?: string }

function Glyph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const stroke = {
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
}

export function IconDashboard(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <rect x="2.2" y="2.2" width="5.2" height="5.2" rx="1" {...stroke} />
      <rect x="8.6" y="2.2" width="5.2" height="5.2" rx="1" {...stroke} />
      <rect x="2.2" y="8.6" width="5.2" height="5.2" rx="1" {...stroke} />
      <rect x="8.6" y="8.6" width="5.2" height="5.2" rx="1" {...stroke} />
    </Glyph>
  )
}

export function IconStore(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <path d="M2.5 6.2 3.4 3.2h9.2l.9 3" {...stroke} />
      <path d="M3 6.2v6.6h10V6.2" {...stroke} />
      <path d="M6.5 12.8V8.8h3v4" {...stroke} />
    </Glyph>
  )
}

export function IconDownload(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <path d="M8 3.2v6.4" {...stroke} />
      <path d="M5.2 7.4 8 10.2l2.8-2.8" {...stroke} />
      <path d="M3.2 12.8h9.6" {...stroke} />
    </Glyph>
  )
}

export function IconList(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <path d="M3 4h10" {...stroke} />
      <path d="M3 8h10" {...stroke} />
      <path d="M3 12h10" {...stroke} />
    </Glyph>
  )
}

export function IconBag(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <path d="M3.2 5.5h9.6l-.7 7.3H3.9L3.2 5.5Z" {...stroke} />
      <path d="M6 5.5V4.4A2 2 0 0 1 8 2.4 2 2 0 0 1 10 4.4v1.1" {...stroke} />
    </Glyph>
  )
}

export function IconChat(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <path d="M3.2 3.4h9.6v7.2H6.6L3.2 13V3.4Z" {...stroke} />
    </Glyph>
  )
}

export function IconBolt(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <path d="M9.2 2.4 4.6 8.6h3.2L6.8 13.6l4.8-6.4H8.4L9.2 2.4Z" {...stroke} />
    </Glyph>
  )
}

export function IconMail(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <rect x="2.4" y="3.8" width="11.2" height="8.4" rx="1.2" {...stroke} />
      <path d="M3 4.6 8 8.4l5-3.8" {...stroke} />
    </Glyph>
  )
}

export function IconBell(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <path d="M8 2.6a4 4 0 0 1 4 4v2.4l1 1.6H3l1-1.6V6.6a4 4 0 0 1 4-4Z" {...stroke} />
      <path d="M6.4 12.8a1.6 1.6 0 0 0 3.2 0" {...stroke} />
    </Glyph>
  )
}

export function IconShield(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <path d="M8 2.4 13.2 4.4v4.2c0 3-2.1 4.8-5.2 5.8C4.9 13.4 2.8 11.6 2.8 8.6V4.4L8 2.4Z" {...stroke} />
    </Glyph>
  )
}

export function IconPulse(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <path d="M2.2 8h2.4l1.4-3.4 2.2 6.8 1.6-3.4H13.8" {...stroke} />
    </Glyph>
  )
}

export function IconGear(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <circle cx="8" cy="8" r="2.2" {...stroke} />
      <path d="M8 2.4v1.6M8 12v1.6M2.4 8h1.6M12 8h1.6M4 4l1.1 1.1M10.9 10.9 12 12M12 4l-1.1 1.1M5.1 10.9 4 12" {...stroke} />
    </Glyph>
  )
}

export function IconPackage(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <path d="M3 5.2 8 2.6l5 2.6v5.6L8 13.4 3 10.8V5.2Z" {...stroke} />
      <path d="M3 5.2 8 7.8l5-2.6M8 7.8v5.6" {...stroke} />
    </Glyph>
  )
}

export function IconUser(p: IconProps) {
  return (
    <Glyph className={p.className}>
      <circle cx="8" cy="5.4" r="2.2" {...stroke} />
      <path d="M3.2 13.2c.5-2.4 2.2-3.6 4.8-3.6s4.3 1.2 4.8 3.6" {...stroke} />
    </Glyph>
  )
}

export function navIconForHref(href: string) {
  switch (href) {
    case "/app/dashboard":
      return IconDashboard
    case "/app/stores":
      return IconStore
    case "/app/import":
      return IconDownload
    case "/app/listings":
      return IconList
    case "/app/orders":
      return IconBag
    case "/app/customer-service":
      return IconChat
    case "/app/stock-alerts":
      return IconBell
    case "/app/stock-guard":
      return IconShield
    case "/app/activity":
      return IconPulse
    case "/app/settings":
      return IconGear
    case "/app/admin/amazon-worker":
      return IconPackage
    case "/app/admin/users":
      return IconUser
    default:
      return IconList
  }
}
