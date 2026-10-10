# Google OAuth verification readiness

## Production OAuth configuration

- Authorized domain: `listjetgo.com`
- Authorized JavaScript origin: `https://app.listjetgo.com`
- Authorized redirect URI: `https://api.listjetgo.com/app/mailbox/callback`
- Requested Gmail scope: `https://www.googleapis.com/auth/gmail.readonly`
- Requested identity scope: `https://www.googleapis.com/auth/userinfo.email`

Do not place client secrets, access tokens, or refresh tokens in verification submissions or demo recordings.

## Justification for `gmail.readonly`

ListJetGo reads transactional Gmail messages relevant to marketplace operations. Complete message-body access
is necessary because Amazon order numbers, purchase prices and final costs, shipment and delivery details,
cancellation, refund, return, payout, and other supported transactional fields may appear in message bodies
rather than message headers.

`gmail.metadata` is insufficient because it provides message metadata and headers but not the complete body
content required for parsing, safe order matching, and order or finance enrichment. ListJetGo requests read-only
access and does not request Gmail send, compose, modify, insert, or delete permissions. Gmail data is not used
for advertising or unrelated profiling.

ListJetGo selectively queries supported Amazon and eBay transactional categories, applies existing matching
safeguards, and leaves ambiguous matches for review. Gmail OAuth refresh tokens are encrypted at rest.

## Demo-video checklist

1. Show the public ListJetGo homepage, Privacy Policy, Terms of Service, and Data Deletion page.
2. Log in to ListJetGo using the production web application.
3. Open Settings and the Connected Mailboxes section.
4. Select Connect Gmail and show the Google consent screen in English.
5. Show the ListJetGo application name, OAuth client ID in the browser flow, and requested read-only permission.
6. Complete authorization and show the Gmail connection in Connected Mailboxes.
7. Show ingestion of a relevant supported transactional email.
8. Show the email safely matched to an existing order.
9. Show the resulting Amazon order number or purchase-cost information in ListJetGo.
10. Disconnect Gmail in ListJetGo.
11. Explain Google Account permission revocation and the ListJetGo data-deletion request process.
12. State that ListJetGo does not request Gmail send, modify, or delete permission and does not use Gmail data for advertising.

## Submission notes

- Use an unlisted video URL and a test account containing only suitable demonstration data.
- Describe the server-side data flow and why `gmail.metadata` cannot support body parsing.
- Declare both requested scopes in Google Auth Platform Data Access.
- Do not claim approval, verification, or security-assessment completion until Google confirms it.
- Complete restricted-scope verification and the applicable independent security assessment before public launch.

## Optional client separation assessment

Google Sign-In and Gmail mailbox authorization currently share `GOOGLE_CLIENT_ID`. They can be separated later:

- Login/GIS would continue using `GOOGLE_CLIENT_ID` in `modules/auth/googleCredential.ts`, the auth routes, and the panel Google Sign-In component.
- Gmail authorization would use dedicated variables such as `GOOGLE_MAILBOX_CLIENT_ID` and `GOOGLE_MAILBOX_CLIENT_SECRET` in `modules/mailbox/gmailClient.ts`.
- Google Cloud would need a separate Web OAuth client with the mailbox callback URI.
- No database migration is required because stored mailbox tokens and provider identities are not keyed by OAuth client ID.
- Existing Gmail refresh tokens were issued to the current client and cannot be refreshed with a new client secret. Connected mailbox users would therefore need to reconnect if mailbox authorization moves to a new client.

Separation is safe to postpone for the current verification submission. Changing clients after verification would
require coordinated Google configuration, verification coverage, deployment, and a managed reconnect plan.
