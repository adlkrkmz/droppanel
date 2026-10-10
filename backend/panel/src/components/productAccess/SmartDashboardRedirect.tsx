"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { fetchProductAccess } from "@/lib/productAccess/client"
import { resolvePostLoginDestination } from "@/lib/productAccess/routing"

type SmartDashboardRedirectProps = { fallback?: "/dashboard/ebay" }

/** Client redirect based on product access snapshot. */
export default function SmartDashboardRedirect({
  fallback = "/dashboard/ebay",
}: SmartDashboardRedirectProps) {
  const router = useRouter()

  useEffect(() => {
    let cancelled = false

    async function run() {
      const snapshot = await fetchProductAccess()
      if (cancelled) return
      if (!snapshot) {
        router.replace("/login")
        return
      }
      router.replace(resolvePostLoginDestination(snapshot.access))
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [router, fallback])

  return (
    <div
      style={{
        minHeight: "40vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--dim)",
        fontSize: 14,
      }}
    >
      Routing to your workspace…
    </div>
  )
}
