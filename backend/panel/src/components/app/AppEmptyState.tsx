import Link from "next/link"
import type { ReactNode } from "react"

type AppEmptyStateLink = {
  href: string
  label: string
}

type AppEmptyStateProps = {
  title: string
  description: string
  primaryHref?: string
  primaryLabel?: string
  onPrimaryClick?: () => void
  primaryConnecting?: boolean
  secondaryLinks?: AppEmptyStateLink[]
  extra?: ReactNode
}

export function AppEmptyState({
  title,
  description,
  primaryHref,
  primaryLabel,
  onPrimaryClick,
  primaryConnecting = false,
  secondaryLinks = [],
  extra,
}: AppEmptyStateProps) {
  const hasPrimary = Boolean(primaryHref || onPrimaryClick)

  return (
    <div className="app-empty-state">
      <p className="app-empty-state-title">{title}</p>
      <p className="app-empty-state-desc">{description}</p>
      {extra}
      {(hasPrimary || secondaryLinks.length > 0) && (
        <div className="app-empty-state-actions">
          {onPrimaryClick ? (
            <button
              type="button"
              onClick={onPrimaryClick}
              disabled={primaryConnecting}
              className="app-empty-state-btn app-empty-state-btn--primary"
            >
              {primaryConnecting ? "Connecting…" : primaryLabel ?? "Continue"}
            </button>
          ) : primaryHref ? (
            <Link href={primaryHref} className="app-empty-state-btn app-empty-state-btn--primary">
              {primaryLabel ?? "Continue"}
            </Link>
          ) : null}
          {secondaryLinks.map(link => (
            <Link key={link.href + link.label} href={link.href} className="app-empty-state-btn">
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
