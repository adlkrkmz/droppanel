import { Suspense } from "react"
import DashboardOrdersScreen from "@/components/orders/DashboardOrdersScreen"

export default function OrdersPage() {
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: "center", color: "var(--dim)" }}>Yükleniyor…</div>}>
      <DashboardOrdersScreen />
    </Suspense>
  )
}
