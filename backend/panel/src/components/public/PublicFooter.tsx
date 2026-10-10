import { CONTACT_EMAIL } from '@/components/public/complianceUi'

const FOOTER_LINKS = [
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/terms', label: 'Terms' },
  { href: '/data-deletion', label: 'Data Deletion' },
  { href: '/demo', label: 'Demo' },
  { href: `mailto:${CONTACT_EMAIL}`, label: 'Contact' },
] as const

type PublicFooterProps = {
  showGrid?: boolean
  /** Homepage uses ListJetGo product chrome; legal pages keep compact bar only. */
  variant?: 'listjetgo' | 'compliance'
}

export default function PublicFooter({
  showGrid = false,
  variant = 'compliance',
}: PublicFooterProps) {
  const isHome = variant === 'listjetgo'

  return (
    <footer className="pub-footer">
      {showGrid && (
        <div className="pub-footer-grid">
          <div className="pub-footer-col">
            <p className="pub-footer-brand">ListJetGo</p>
            <p>
              AI-powered discovery, saturation analysis, and multi-store dispatch for ecommerce
              operations.
            </p>
          </div>
          <div className="pub-footer-col">
            <h4>Product</h4>
            <ul>
              <li>
                <a href="/#scanner">Market scanner</a>
              </li>
              <li>
                <a href="/demo">Demo</a>
              </li>
              <li>
                <a href="/login">Sign In</a>
              </li>
            </ul>
          </div>
          <div className="pub-footer-col">
            <h4>Legal</h4>
            <ul>
              <li>
                <a href="/privacy">Privacy Policy</a>
              </li>
              <li>
                <a href="/terms">Terms of Service</a>
              </li>
              <li>
                <a href="/data-deletion">Data Deletion Request</a>
              </li>
            </ul>
          </div>
          <div className="pub-footer-col">
            <h4>Platform</h4>
            <ul>
              <li>Multi-store dispatch</li>
              <li>Demo-mode market previews</li>
              <li>No live production data on marketing pages</li>
            </ul>
          </div>
        </div>
      )}
      <div className="pub-footer-bar">
        <nav className="pub-footer-links" aria-label="Footer">
          {FOOTER_LINKS.map((link, i) => (
            <span key={link.href} style={{ display: 'contents' }}>
              {i > 0 && <span>|</span>}
              <a href={link.href}>{link.label}</a>
            </span>
          ))}
        </nav>
        <p className="pub-footer-copy">
          {isHome
            ? '© 2026 ListJetGo · Demo previews use simulated data only.'
            : '© 2026 ListJetGo'}
        </p>
      </div>
    </footer>
  )
}
