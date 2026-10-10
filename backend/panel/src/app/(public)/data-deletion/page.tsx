import type { Metadata } from 'next'
import { CONTACT_EMAIL } from '@/components/public/complianceUi'

export const metadata: Metadata = {
  title: 'Data Deletion | ListJetGo',
  description: 'How to disconnect Gmail, revoke Google access, or request deletion of ListJetGo data.',
}

export default function DataDeletionPage() {
  return (
    <article className="pub-legal">
      <h1>Data Deletion and Account Removal</h1>
      <p className="pub-legal-meta">ListJetGo · Last updated: October 3, 2026</p>

      <h2>Disconnect a Gmail account</h2>
      <ol>
        <li>Sign in to ListJetGo.</li>
        <li>Open Settings and locate Connected Mailboxes.</li>
        <li>Select Disconnect for the Gmail account you want to disconnect.</li>
      </ol>
      <p>
        Disconnecting changes the mailbox to a disconnected state and stops future mailbox synchronization.
        ListJetGo may retain the encrypted OAuth token and historical mailbox-derived records until they are
        deleted through a verified deletion request or otherwise removed under applicable retention practices.
      </p>

      <h2>Revoke Google Account permission</h2>
      <p>
        You can separately revoke ListJetGo&apos;s Google authorization from your Google Account. Open your
        Google Account, go to Security, locate your third-party connections, select ListJetGo, and remove its
        access. Revocation prevents future Google API access but does not automatically delete historical data
        already stored by ListJetGo.
      </p>

      <h2>Request deletion</h2>
      <p>
        ListJetGo does not currently provide a fully automated account-deletion control. To request deletion,
        email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> from the address associated with your
        ListJetGo account. State that you are requesting data deletion and identify the account or workspace.
        We may ask you to verify ownership before acting on the request.
      </p>
      <p>A verified request may cover:</p>
      <ul>
        <li>ListJetGo account and profile data;</li>
        <li>connected Gmail mailbox records and encrypted OAuth tokens;</li>
        <li>stored Gmail message content, metadata, and parsed Gmail-derived records;</li>
        <li>mailbox-to-order links and supported transactional enrichment data;</li>
        <li>connected marketplace or store identifiers and account metadata; and</li>
        <li>other personal data associated with the identified account.</li>
      </ul>

      <h2>Retention exceptions</h2>
      <p>
        We will delete or anonymize applicable data after verification within a reasonable period. Certain
        historical order, transaction, security, audit, dispute, or account records may be retained where
        reasonably required for legal compliance, fraud prevention, operational integrity, or the protection
        of users and the service. Any retained data remains subject to the Privacy Policy.
      </p>

      <h2>Contact</h2>
      <p>Data-deletion and account-removal requests: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>
      <p>For more information, see our <a href="/privacy">Privacy Policy</a>.</p>
    </article>
  )
}
