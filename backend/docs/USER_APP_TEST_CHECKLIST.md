# User App — Internal Test Checklist

Manual QA checklist for the ListJetGo eBay user panel (`/app/*`). Use test user `testuser@gmail.com` / `StrongPass123!` unless noted.

---

## 1. Auth

- [ ] **Register** — new user can sign up via `/app/register` (or public register flow)
- [ ] **Email verify** — verification link / token flow completes
- [ ] **Pending approval** — unapproved user is redirected to `/pending-approval`, not app pages
- [ ] **Active login** — approved user reaches `/app/dashboard` after `/app/login`
- [ ] **Logout** — AppShell header Logout clears session and returns to `/app/login`

---

## 2. User App Navigation

- [ ] **Dashboard** — `/app/dashboard` loads inside AppShell
- [ ] **Stores** — `/app/stores`
- [ ] **Import** — `/app/import`
- [ ] **Listings** — `/app/listings`
- [ ] **Settings** — `/app/settings`
- [ ] **Stock alerts** — `/app/stock-alerts`
- [ ] Sidebar + mobile nav highlight active route
- [ ] AppShell “Need help?” link goes to Dashboard
- [ ] `/app/login` renders without AppShell sidebar

---

## 3. eBay Connect

- [ ] **GET `/app/ebay/status`** — returns connected stores for logged-in workspace
- [ ] **POST `/app/ebay/connect`** — returns OAuth URL; browser redirects to eBay
- [ ] **Callback redirect URI** — eBay callback lands on configured redirect; success shows `?ebayConnected=1` banner on stores/dashboard
- [ ] Connect from Stores page and Dashboard onboarding both work
- [ ] Empty store state shows consistent copy + “Connect eBay Store” CTA

---

## 4. Import Flow

- [ ] **Sync listings** — Import page “Import Listings” triggers `POST /app/listings/sync`
- [ ] **Import status** — status card shows sync state; polling updates while running
- [ ] **ASIN match** — “Link Amazon ASINs” textarea + submit calls import-match endpoint
- [ ] Deep link `/app/import?mode=asin-match` scrolls to ASIN section
- [ ] No-store empty state: “Connect a store before importing” + Manage Stores CTA
- [ ] Import / ASIN match are **not** marked “Coming soon”

---

## 5. Listings

- [ ] **Filters** — Needs ASIN, ASIN linked, Source tracked, Source missing (current page only)
- [ ] **ASIN badges** — linked vs needs-ASIN badges visible in table
- [ ] **Recommended price modal** — “View Price” (ASIN linked only) opens read-only modal via `GET /app/listings/recommended-price`
- [ ] No apply/update price button in modal
- [ ] Empty catalog: “No listings imported yet” + Import Listings CTA
- [ ] “Link ASINs” toolbar link goes to import page

---

## 6. Settings

- [ ] **Markup save** — save markup percent for selected store
- [ ] **Address save** — warehouse / ship-from address fields persist
- [ ] **Policies save** — payment / return / shipping policy IDs save
- [ ] **Warehouse banner save** — banner toggle / text saves
- [ ] No-store empty state: “Connect a store to configure settings” + Manage Stores CTA
- [ ] Store selector switches settings per store

---

## 7. Stock Alerts

- [ ] **Filters** — review status + risk filter (frontend, current page)
- [ ] **Badges** — source status / risk hints render
- [ ] **Quick links** — View Listing, Link ASIN, Settings (read-only; no alert actions)
- [ ] Empty state: “No stock alerts yet” + View Listings / Import Listings CTAs
- [ ] Help copy states actions are not enabled in user panel

---

## 8. Security / Spoof Tests

Use a store code outside the user workspace (e.g. `S4` with `testuser`) — all must return **404**, not another workspace’s data:

- [ ] `testuser` + **S4** on app settings
- [ ] App settings spoof (`GET/PUT /app/settings?storeCode=S4`)
- [ ] App listings spoof (`GET /app/listings?storeCode=S4`)
- [ ] App import sync spoof (`POST /app/listings/sync` body `storeCode: S4`)
- [ ] App import-match spoof (`POST /app/listings/import-match` with S4)
- [ ] App stock-alerts spoof (`GET /app/stock-alerts?storeCode=S4`)
- [ ] **Admin endpoints still work** — admin login + admin routes unchanged

---

## 9. Regression

- [ ] **Admin login** — `/login` (admin) still works
- [ ] **Admin settings** — layout and save flows intact
- [ ] **Admin listings** — list / filters / actions intact
- [ ] **Admin stock alerts** — list and actions intact
- [ ] **Extension publish flow** — not touched by user-panel changes

---

## Empty State & Help Copy (Phase 3K)

- [ ] All `/app` pages show consistent empty-state title + reason + CTA
- [ ] “How it works” help box on: Dashboard, Stores, Import, Listings, Settings, Stock Alerts
- [ ] Dashboard onboarding: Connect → Settings → Import → Link ASINs → Review Alerts
- [ ] Price update / publish / stock alert **actions** still disabled or absent in user panel

---

## Build

```bash
cd panel
npm run build
```

Expected: production build succeeds with no TypeScript errors.
