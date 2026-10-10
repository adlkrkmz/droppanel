'use client'

import { useState } from 'react'

const TABS = ['Connect', 'Ingest', 'Match', 'Disconnect'] as const
type Tab = (typeof TABS)[number]

export default function DemoWalkthrough() {
  const [tab, setTab] = useState<Tab>('Connect')

  return (
    <>
      <header className="pub-demo-header">
        <h1>See ListJetGo Mailbox Enrichment in Action</h1>
        <p style={{ color: 'var(--pub-body)', lineHeight: 1.7, maxWidth: '52ch' }}>
          A static walkthrough of the Gmail connection and transactional order-enrichment flow.
        </p>
      </header>

      <div className="pub-notice" role="note">
        This demonstration is illustrative. It does not connect a Gmail account or collect data on this page.
      </div>

      <div className="pub-tabs" role="tablist" aria-label="Demo steps">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`pub-tab${tab === t ? ' pub-tab--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'Connect' && (
          <div className="pub-card" style={{ maxWidth: '560px' }}>
            <h3 style={{ color: 'var(--pub-headline)', marginBottom: '12px', fontSize: '1.05rem' }}>
              Connect through OAuth
            </h3>
            <p style={{ color: 'var(--pub-body)', lineHeight: 1.65, fontSize: '0.95rem' }}>
              The user signs in to ListJetGo and authorizes read-only Gmail access through Google&apos;s
              OAuth screen. ListJetGo never asks for or stores the user&apos;s Google password.
            </p>
          </div>
        )}

        {tab === 'Ingest' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '24px', alignItems: 'flex-start' }}>
            <div className="pub-pin-preview">
              <div className="pub-pin-image">Transactional email preview</div>
              <div className="pub-pin-body">
                <div className="pub-pin-field">
                  <strong>Mailbox</strong>
                  <span>Connected Gmail account</span>
                </div>
                <div className="pub-pin-field">
                  <strong>Category</strong>
                  <span>Supported Amazon or eBay transaction</span>
                </div>
                <div className="pub-pin-field">
                  <strong>Extracted fields</strong>
                  <span>Order number, purchase cost, and supported shipment details</span>
                </div>
                <div className="pub-pin-field">
                  <strong>Permission</strong>
                  <span>Gmail read-only</span>
                </div>
              </div>
            </div>
            <div className="pub-card" style={{ flex: 1, minWidth: '240px', maxWidth: '400px' }}>
              <h3 style={{ color: 'var(--pub-headline)', marginBottom: '12px', fontSize: '1.05rem' }}>
                Read relevant transactions
              </h3>
              <p style={{ color: 'var(--pub-body)', lineHeight: 1.65, fontSize: '0.95rem' }}>
                ListJetGo selectively processes supported transactional email categories. It does not request
                Gmail permission to send, modify, or delete messages.
              </p>
            </div>
          </div>
        )}

        {tab === 'Match' && (
          <div>
            <div className="pub-card" style={{ maxWidth: '560px', marginBottom: '20px' }}>
              <h3 style={{ color: 'var(--pub-headline)', marginBottom: '12px', fontSize: '1.05rem' }}>
                Match to an existing order
              </h3>
              <p style={{ color: 'var(--pub-body)', lineHeight: 1.65, fontSize: '0.95rem' }}>
                Existing matching safeguards use supported order and transaction evidence. Ambiguous or weak
                matches remain unmatched or are marked for review.
              </p>
            </div>
            <p className="pub-approval-note">
              Purchase-cost and order information is populated only when supported by email evidence.
            </p>
          </div>
        )}

        {tab === 'Disconnect' && (
          <div className="pub-card" style={{ maxWidth: '560px' }}>
            <h3 style={{ color: 'var(--pub-headline)', marginBottom: '16px', fontSize: '1.05rem' }}>
              Disconnect and revoke
            </h3>
            <div className="pub-pin-field" style={{ marginBottom: '16px' }}>
              <strong>Mailbox status</strong>
              <span>Disconnected</span>
            </div>
            <div className="pub-status">Future synchronization stopped</div>
            <p style={{ color: 'var(--pub-body)', lineHeight: 1.65, fontSize: '0.9rem', marginTop: '16px' }}>
              Users can disconnect Gmail in ListJetGo, revoke authorization in their Google Account, and use
              the published Data Deletion process to request deletion of stored mailbox data and tokens.
            </p>
          </div>
        )}
      </div>

      <p className="pub-approval-note" style={{ marginTop: '32px' }}>
        <strong>Compliance note:</strong> Gmail data is used for supported ListJetGo functionality and not for advertising.
      </p>
    </>
  )
}
