import type { Metadata } from 'next'
import { CONTACT_EMAIL } from '@/components/public/complianceUi'

export const metadata: Metadata = {
  title: 'Privacy Policy | ListJetGo',
  description: 'How ListJetGo accesses, uses, stores, and protects account, marketplace, and Gmail data.',
}

export default function PrivacyPage() {
  return (
    <article className="pub-legal">
      <h1>Privacy Policy</h1>
      <p className="pub-legal-meta">ListJetGo · Effective date: October 3, 2026</p>
      <p>
        ListJetGo provides ecommerce operations and marketplace-management software. This Policy explains
        how ListJetGo accesses, uses, stores, and shares information when you use the web application,
        connected services, and ListJetGo Companion browser extension.
      </p>

      <h2>1. Information we process</h2>
      <ul>
        <li>ListJetGo account and profile information, authentication methods, and workspace membership.</li>
        <li>Connected marketplace and store identifiers, account status, listings, orders, and operational data.</li>
        <li>OAuth account identifiers, granted scopes, encrypted tokens, and connection status.</li>
        <li>The email address of each connected Gmail account.</li>
        <li>Relevant Gmail message metadata and content needed for supported transactional workflows.</li>
        <li>Parsed order and transaction information, including Amazon order numbers and purchase costs.</li>
        <li>Supported eBay and Amazon operational-email data, such as sales, shipment, delivery, cancellation, return, refund, and payout information where implemented.</li>
        <li>Operational logs, error records, device or browser information, security events, sessions, and IP information.</li>
        <li>Product information processed by ListJetGo Companion when you request a supported capture workflow.</li>
      </ul>

      <h2>2. Google and Gmail access</h2>
      <p>When you connect Gmail, ListJetGo requests these Google OAuth scopes:</p>
      <ul>
        <li><code>https://www.googleapis.com/auth/gmail.readonly</code> — read-only access to Gmail messages and settings.</li>
        <li><code>https://www.googleapis.com/auth/userinfo.email</code> — access to the connected Google Account email address and account identity.</li>
      </ul>
      <p>
        Read-only Gmail access is used to identify and read relevant transactional emails so ListJetGo can
        support order matching, shipment and delivery enrichment, purchase-cost extraction, finance and
        profit calculations, supported cancellation, refund, return, payout, and transaction workflows, and
        mailbox-review workflows. ListJetGo does not request Gmail permission to send, compose, modify,
        insert, or delete messages.
      </p>

      <h2>3. Selective mailbox processing</h2>
      <p>
        ListJetGo is designed to query and process supported transactional categories, including relevant
        Amazon and eBay operational emails. Gmail data is not used for advertising, unrelated profiling,
        credit eligibility, or sale to third parties. Messages that cannot be matched safely may remain
        unmatched or be marked for review rather than being forced onto an order.
      </p>

      <h2>4. How we use information</h2>
      <ul>
        <li>Authenticate users, secure accounts, and operate workspaces.</li>
        <li>Connect and synchronize authorized marketplace, store, and Gmail accounts.</li>
        <li>Import and manage listings, orders, inventory, and operational workflows.</li>
        <li>Parse supported transactional emails and link them to orders using applicable matching safeguards.</li>
        <li>Populate supported order, delivery, purchase-cost, and finance inputs from transactional evidence.</li>
        <li>Provide mailbox review, customer-service, reporting, and security functionality.</li>
        <li>Diagnose errors, prevent abuse, maintain the service, and comply with legal obligations.</li>
      </ul>

      <h2>5. Storage and retention</h2>
      <p>
        Gmail OAuth refresh tokens are stored in encrypted form. Gmail messages used by supported workflows
        are processed server-side, and ListJetGo may retain mailbox records, parsed transactional data, and
        mailbox-to-order links needed to provide and audit the service. Data is retained while reasonably
        needed to provide the service, protect its security and integrity, resolve disputes, meet operational
        requirements, or comply with law. We do not state a fixed retention period where none is implemented.
      </p>

      <h2>6. Sharing and service providers</h2>
      <p>
        ListJetGo does not sell Google user data or other personal information. Information may be processed
        by hosting, infrastructure, security, communications, and other service providers only as necessary
        to operate and protect ListJetGo. Information may also be disclosed when required by law, to protect
        rights or safety, or in connection with a legitimate business transfer subject to applicable safeguards.
      </p>

      <h2>7. Google API Services User Data Policy</h2>
      <p>
        ListJetGo&apos;s use and transfer to any other app of information received from Google APIs will adhere
        to the Google API Services User Data Policy, including the Limited Use requirements.
      </p>

      <h2>8. Security</h2>
      <p>
        We use technical and organizational safeguards designed to protect information, including encrypted
        OAuth-token storage and access controls. No system can guarantee absolute security, and users remain
        responsible for protecting their devices and ListJetGo credentials.
      </p>

      <h2>9. Your controls and deletion choices</h2>
      <ul>
        <li>You may disconnect a Gmail mailbox from ListJetGo settings to stop future mailbox synchronization.</li>
        <li>You may revoke ListJetGo access through your Google Account&apos;s third-party connection settings.</li>
        <li>You may request deletion of your account, connected mailbox records, Gmail-derived records, OAuth tokens, and store metadata through the process on our <a href="/data-deletion">Data Deletion page</a>.</li>
        <li>Some records may be retained where reasonably required for security, legal compliance, dispute resolution, or operational integrity.</li>
      </ul>
      <p>
        Disconnecting a mailbox stops its connected status but does not by itself represent a request to
        delete all previously stored records. Use the Data Deletion process for a deletion request.
      </p>

      <h2>10. Children</h2>
      <p>ListJetGo is not directed to children and is intended for authorized ecommerce operators.</p>

      <h2>11. Changes to this Policy</h2>
      <p>We may update this Policy as features, practices, or legal requirements change. Updates will be published here with a revised effective date.</p>

      <h2>12. Contact</h2>
      <p>Privacy questions and requests may be sent to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
    </article>
  )
}
