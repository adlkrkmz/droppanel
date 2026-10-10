import type { Metadata } from 'next'
import { CONTACT_EMAIL } from '@/components/public/complianceUi'

export const metadata: Metadata = {
  title: 'Terms of Service | ListJetGo',
  description: 'Terms governing use of the ListJetGo ecommerce operations platform.',
}

export default function TermsPage() {
  return (
    <article className="pub-legal">
      <h1>Terms of Service</h1>
      <p className="pub-legal-meta">ListJetGo · Last updated: October 3, 2026</p>
      <p>
        These Terms govern your use of ListJetGo, an ecommerce operations and marketplace-management
        software service. By creating an account or using the service, you agree to these Terms. If you
        do not agree, do not use ListJetGo.
      </p>

      <h2>1. Accounts and authorized access</h2>
      <p>
        You must provide accurate account information, protect your credentials, and remain responsible
        for activity performed through your account. You may connect only marketplace, store, Gmail, and
        other third-party accounts that you own or are authorized to manage.
      </p>

      <h2>2. Service functionality</h2>
      <p>
        ListJetGo may provide order imports, listing and inventory workflows, connected-store management,
        mailbox-based transaction processing, customer-service tools, and finance or profit views. Features
        may depend on the data and permissions made available by connected services.
      </p>

      <h2>3. Connected Gmail accounts</h2>
      <p>
        If you connect Gmail, you authorize ListJetGo to read supported transactional messages for the
        purposes described in our Privacy Policy, including order matching and operational or financial
        enrichment. ListJetGo does not request Gmail permission to send, modify, or delete email. You may
        disconnect a mailbox in ListJetGo and may separately revoke access through your Google Account.
      </p>

      <h2>4. Third-party services</h2>
      <p>
        ListJetGo interoperates with third-party services such as Google and Gmail, eBay, and data contained
        in supported Amazon transactional emails. Those services are governed by their own terms, policies,
        availability, and technical limits. ListJetGo is not affiliated with or endorsed by Google, Gmail,
        eBay, Amazon, Etsy, or other third-party platforms unless expressly stated otherwise.
      </p>

      <h2>5. Acceptable use</h2>
      <ul>
        <li>Do not access accounts or data without authorization.</li>
        <li>Do not use ListJetGo for fraud, spam, unlawful messaging, or deceptive marketplace activity.</li>
        <li>Do not interfere with the service, bypass security controls, or misuse third-party APIs.</li>
        <li>Review automated or suggested actions and comply with applicable marketplace rules and law.</li>
      </ul>

      <h2>6. Your data and instructions</h2>
      <p>
        You remain responsible for data, listings, communications, and instructions submitted through your
        account. Our processing of account, marketplace, and Gmail-derived data is described in the Privacy
        Policy. You must not provide data that you lack the right to process.
      </p>

      <h2>7. Availability and changes</h2>
      <p>
        We work to operate ListJetGo reliably, but do not guarantee uninterrupted or error-free availability.
        Maintenance, security events, third-party outages, API changes, quotas, or account restrictions may
        affect features. We may update, suspend, or discontinue functionality when reasonably necessary.
      </p>

      <h2>8. Suspension and termination</h2>
      <p>
        We may restrict or terminate access when these Terms are violated, use creates security or legal risk,
        payment or eligibility requirements are not met, or a connected provider requires it. You may stop
        using the service and request account-data deletion as explained on our Data Deletion page.
      </p>

      <h2>9. Disclaimers and limitation of liability</h2>
      <p>
        ListJetGo is provided on an “as available” basis to the extent permitted by law. Marketplace results,
        parsed email data, financial estimates, and automated matches should be reviewed before relying on
        them. To the maximum extent permitted by law, ListJetGo is not liable for indirect, incidental,
        consequential, special, or punitive damages, or for losses caused by third-party services or
        unauthorized use of your account.
      </p>

      <h2>10. Changes to these Terms</h2>
      <p>
        We may update these Terms as the service or legal requirements change. The updated version will be
        published here with a revised date. Continued use after an update constitutes acceptance where
        permitted by law.
      </p>

      <h2>11. Contact</h2>
      <p>Questions about these Terms may be sent to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
    </article>
  )
}
