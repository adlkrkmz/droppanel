'use client'

import { useState } from 'react'

const LINKS = [
  { href: '/demo', label: 'Demo' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/data-deletion', label: 'Data Deletion' },
] as const

export default function PublicNav() {
  const [open, setOpen] = useState(false)

  return (
    <header className="pub-nav">
      <div className="pub-nav-inner">
        <a href="/" className="pub-brand">
          ListJetGo
        </a>
        <nav className="pub-nav-links" aria-label="Main">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <div className="pub-nav-actions">
          <a href="/login" className="pub-btn pub-btn--primary">
            Sign In
          </a>
          <button
            type="button"
            className="pub-menu-btn"
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
        className={`pub-mobile-menu${open ? ' pub-mobile-menu--open' : ''}`}
        aria-label="Mobile"
      >
        {LINKS.map((l) => (
          <a key={l.href} href={l.href} onClick={() => setOpen(false)}>
            {l.label}
          </a>
        ))}
        <a href="/login" onClick={() => setOpen(false)}>
          Sign In
        </a>
      </nav>
    </header>
  )
}
