'use client'

import { useState } from 'react'

const LINKS = [
  { href: '#platform', label: 'Platform' },
  { href: '#operations', label: 'Operations' },
  { href: '#intelligence', label: 'Intelligence' },
  { href: '#access', label: 'Access' },
] as const

export default function HomepageNav() {
  const [open, setOpen] = useState(false)

  return (
    <header>
      <div className="lj-land-nav">
        <a href="/" className="lj-land-brand">
          <span className="lj-land-mark">LJ</span>
          <span className="lj-land-wordmark">ListJetGo</span>
        </a>
        <nav className="lj-land-links" aria-label="Main">
          {LINKS.map(l => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <div className="lj-land-actions">
          <a href="/login" className="lj-land-signin">
            Giriş Yap
          </a>
          <a href="/register?product=ebay" className="lj-land-cta-primary">
            14 Gün Ücretsiz Dene
          </a>
          <button
            type="button"
            className="lj-land-menu-btn"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </div>
      <nav
        className={`lj-land-mobile${open ? ' lj-land-mobile--open' : ''}`}
        aria-label="Mobile"
      >
        {LINKS.map(l => (
          <a key={l.href} href={l.href} onClick={() => setOpen(false)}>
            {l.label}
          </a>
        ))}
        <a href="/login" onClick={() => setOpen(false)}>
          Giriş Yap
        </a>
        <a href="/register?product=ebay" onClick={() => setOpen(false)}>
          14 Gün Ücretsiz Dene
        </a>
      </nav>
    </header>
  )
}
