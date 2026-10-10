import path from 'path'
import { fileURLToPath } from 'url'

const panelRoot = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  allowedDevOrigins: ['panel.listjetgo.com'],
  turbopack: {
    root: panelRoot,
  },
  async redirects() {
    return [
      { source: '/app/login', destination: '/login', permanent: false },
      { source: '/dashboard', destination: '/app/dashboard', permanent: false },
      { source: '/dashboard/ebay', destination: '/app/dashboard', permanent: false },
      { source: '/dashboard/ebay/onboarding', destination: '/app/dashboard', permanent: false },
      { source: '/settings', destination: '/app/settings', permanent: false },
      { source: '/listings/my-listings', destination: '/app/listings', permanent: false },
      { source: '/monitor', destination: '/app/listings', permanent: false },
      { source: '/listings/import', destination: '/app/import', permanent: false },
      { source: '/listings/stock-alerts', destination: '/app/stock-alerts', permanent: false },
      { source: '/listings/stock-guard-settings', destination: '/app/stock-guard', permanent: false },
      { source: '/orders', destination: '/app/orders', permanent: false },
      { source: '/orders/:path*', destination: '/app/orders', permanent: false },
      { source: '/admin/platform/keepa-monitor', destination: '/app/admin/keepa', permanent: false },
      { source: '/admin/platform/amazon-worker', destination: '/app/admin/amazon-worker', permanent: false },
      { source: '/admin/users/pending', destination: '/app/admin/users', permanent: false },
      { source: '/pool', destination: '/app/dashboard', permanent: false },
      { source: '/scan', destination: '/app/dashboard', permanent: false },
    ]
  },
  async headers() {
    if (process.env.NODE_ENV !== 'production') return []
    return [{
      source: '/:path*',
      headers: [{
        key: 'Content-Security-Policy',
        value: [
          "default-src 'self'",
          "base-uri 'self'",
          "frame-ancestors 'none'",
          "script-src 'self' 'unsafe-inline' https://accounts.google.com",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com",
          "connect-src 'self' https://api.listjetgo.com http://localhost:4000 http://127.0.0.1:4000 https://accounts.google.com",
          "img-src 'self' data: blob: https://api.listjetgo.com https://m.media-amazon.com https://images-na.ssl-images-amazon.com https://i.ebayimg.com",
          "frame-src https://accounts.google.com",
          "object-src 'none'",
        ].join('; '),
      }],
    }]
  },
}

export default nextConfig
