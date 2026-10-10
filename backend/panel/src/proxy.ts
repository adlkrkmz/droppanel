import { NextRequest, NextResponse } from 'next/server'
import { hasPanelSession } from '@/lib/panelAuthServer'

const PUBLIC_EXACT = new Set([
  '/',
  '/privacy',
  '/terms',
  '/demo',
  '/data-deletion',
  '/login',
  '/register',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/pending-approval',
  '/app/login',
  // Authenticated /app/* pages enforce session in-page + API; allow shell entry
  // without forcing legacy /login redirect for first paint.
  '/app/dashboard',
  '/app/stores',
  '/app/listings',
  '/app/settings',
  '/app/stock-alerts',
  '/app/import',
  '/app/orders',
  '/app/customer-service',
  '/app/stock-guard',
  '/app/activity',
])

const PUBLIC_PREFIXES = [
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/register',
  // /app/admin/* — panel host cannot read api.listjetgo.com listjetgo_session.
  // AdminGate (client) + API requireAdmin enforce role=admin + approval active.
  '/app/admin',
]

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/'
  return pathname.endsWith('/') && pathname.length > 1
    ? pathname.slice(0, -1)
    : pathname
}

export function isPublicPath(pathname: string): boolean {
  const path = normalizePathname(pathname)
  if (PUBLIC_EXACT.has(path)) return true
  // Nested routes under allowlisted /app shells (e.g. /app/orders/:id).
  // Canonical session lives on api.listjetgo.com; panel-host cookie is often absent.
  for (const exact of PUBLIC_EXACT) {
    if (exact.startsWith("/app/") && path.startsWith(`${exact}/`)) return true
  }
  return PUBLIC_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  )
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (
    isPublicPath(pathname) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname === '/listjetgo-hero-market-map.jpg' ||
    // Let admin BFF return JSON 401/403 (listjetgo_session gate), not HTML /login redirect
    pathname.startsWith('/api/admin')
  ) {
    return NextResponse.next()
  }

  const session = hasPanelSession(request)
  if (!session) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('from', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/',
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
