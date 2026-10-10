import type { Metadata } from "next"
import "./globals.css"
import "@/components/public/homepage/homepage-entry.css"
import { StoreProvider } from "@/lib/storeContext"
import { ToastProvider } from "@/lib/toastContext"

export const metadata: Metadata = {
  title: "ListJetGo",
  description:
    "AI-powered product discovery, saturation analysis, and multi-store dispatch — operations platform for ecommerce sellers.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-bg text-text font-body antialiased">
        <StoreProvider>
          <ToastProvider>{children}</ToastProvider>
        </StoreProvider>
      </body>
    </html>
  )
}
