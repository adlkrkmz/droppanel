'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import PublicFooter from '@/components/public/PublicFooter'
import PublicNav from '@/components/public/PublicNav'

export default function PublicMarketingLayout({
  children,
  variant = 'prose',
}: {
  children: ReactNode
  variant?: 'home' | 'prose'
}) {
  const pathname = usePathname() ?? ''
  const isUserApp = pathname.startsWith('/app')
  const isAuthPage = pathname === '/login' || pathname === '/register'

  if (isUserApp) {
    return <div className="pub pub--app">{children}</div>
  }

  // Full-bleed auth experience — no marketing nav/footer (fixes register layout bleed)
  if (isAuthPage) {
    return <>{children}</>
  }

  return (
    <div className="pub">
      <PublicNav />
      <main className={`pub-main pub-main--${variant}`}>{children}</main>
      <PublicFooter showGrid={variant === 'home'} />
    </div>
  )
}
