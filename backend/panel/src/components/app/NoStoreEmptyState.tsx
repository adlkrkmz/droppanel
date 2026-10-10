import type { ReactNode } from "react"
import { AppEmptyState } from "@/components/app/AppEmptyState"

type NoStoreEmptyStateProps = {
  title?: string
  description?: string
  cta?: "connect" | "manage-stores"
  onConnect?: () => void
  connecting?: boolean
  extra?: ReactNode
}

export function NoStoreEmptyState({
  title = "No eBay store connected yet.",
  description = "Connect your eBay store to start importing listings and monitoring source risks.",
  cta = "connect",
  onConnect,
  connecting = false,
  extra,
}: NoStoreEmptyStateProps) {
  if (cta === "manage-stores") {
    return (
      <AppEmptyState
        title={title}
        description={description}
        primaryHref="/app/stores"
        primaryLabel="Manage Stores"
        extra={extra}
      />
    )
  }

  return (
    <AppEmptyState
      title={title}
      description={description}
      primaryLabel="Connect eBay Store"
      onPrimaryClick={onConnect}
      primaryConnecting={connecting}
      secondaryLinks={[{ href: "/app/stores", label: "Manage Stores" }]}
      extra={extra}
    />
  )
}
