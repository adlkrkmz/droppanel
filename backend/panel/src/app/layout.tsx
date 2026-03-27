import type { Metadata } from "next"
import "./globals.css"
import Sidebar from "@/components/layout/Sidebar"
import Topbar  from "@/components/layout/Topbar"
import { StoreProvider } from "@/lib/storeContext"
import { ToastProvider } from "@/lib/toastContext"

export const metadata: Metadata = {
  title:       "ListPanel",
  description: "eBay Listing Pipeline — Admin Panel",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StoreProvider>
          <ToastProvider>
            <Sidebar />
            <Topbar />
            <main
              style={{
                marginLeft: "208px",
                marginTop:  "56px",
                minHeight:  "calc(100vh - 56px)",
                padding:    "28px 32px",
                background: "var(--bg)",
              }}
            >
              {children}
            </main>
          </ToastProvider>
        </StoreProvider>
      </body>
    </html>
  )
}
