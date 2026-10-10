import Sidebar from "@/components/layout/Sidebar"
import Topbar  from "@/components/layout/Topbar"
import StoreSync from "@/components/layout/StoreSync"
import NotificationCenter from "@/components/NotificationCenter"
import ExtensionLocalWorkerBridge from "@/components/layout/ExtensionLocalWorkerBridge"

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-dashboard-shell">
      <ExtensionLocalWorkerBridge />
      <StoreSync />
      <Sidebar />
      <Topbar />
      <main className="admin-dashboard-main">
        {children}
      </main>
      <NotificationCenter />
    </div>
  )
}
