# Etsy integration — next steps

This document covers what to do while waiting for Etsy developer support, how to verify the Connection Manager, and what comes next. It applies to the **ListJetGo / eBay backend** (`ebay listing/backend`), not the standalone Etsy project.

Related: [ETSY_OAUTH_ENV.md](./ETSY_OAUTH_ENV.md), [ETSY_LISTING_PUBLISH_PLAN.md](./ETSY_LISTING_PUBLISH_PLAN.md)

---

## OAuth pending with Etsy support

If Etsy shows **“application not recognized”** or OAuth fails despite correct env vars:

1. Confirm callback URL in Etsy Developer app matches **exactly**:
   - Production: `https://api.listjetgo.com/api/etsy/callback`
   - Local: `http://localhost:4000/api/etsy/callback`
2. Confirm `ETSY_CLIENT_ID` / `ETSY_CLIENT_SECRET` are in **`backend/.env`** (not the standalone Etsy project).
3. Panel Settings shows a **support-pending warning** when the server is configured but no shop is connected yet.
4. Contact Etsy developer support for **public OAuth activation** if the app is approved but OAuth is not live.

The panel maps callback errors to readable messages:

| `reason` query param | User message |
|----------------------|--------------|
| `invalid_state` | Connection session expired. Please try again. |
| `exchange_failed` | Etsy authorization failed. Please reconnect. |
| `oauth_denied` | Etsy authorization was cancelled. |
| `config_error` | Etsy connection is not configured correctly. |

---

## Connection test checklist

Run after env + migration + PM2 restart:

1. Open Settings → **BÖLÜM 5 — ETSY CONNECTION**
2. Dev only: confirm diagnostics show `Client ID present: true` (no secrets shown)
3. Click **Connect Etsy** → Etsy authorize screen
4. Approve → redirect to `/settings?etsy=connected`
5. Banner/toast: “Etsy shop connected successfully.”
6. Status shows **Connected** with shop name + shop ID
7. **Test connection** → success toast
8. `GET /api/etsy/status` → `{ connected: true, configured: true, accounts: [...] }`
9. `GET /api/etsy/test` → `{ ok: true }`
10. Restart `droppanel-api` → status still connected (encrypted DB tokens)
11. **Disconnect** → status **Disconnected**, tokens cleared
12. **Reconnect** → OAuth flow again
13. **Remove** → hidden from default list
14. Confirm no raw tokens in browser Network tab or server logs

---

## Current API surface (Connection Manager)

| Route | Purpose |
|-------|---------|
| `GET /api/etsy/connect` | Start OAuth |
| `GET /api/etsy/callback` | Token exchange + DB save |
| `GET /api/etsy/status` | Safe connection metadata + `configured` flag |
| `GET /api/etsy/config` | Safe server config (no secrets) |
| `GET /api/etsy/test` | Verify token + Etsy `users/me` |
| `POST /api/etsy/reconnect` | Returns `{ connectUrl }` |
| `POST /api/etsy/disconnect` | Soft disconnect |
| `POST /api/etsy/remove` | Archive connection |

### Shop Data Sync skeleton (read-only)

| Route | Purpose |
|-------|---------|
| `GET /api/etsy/shop` | Read shop metadata (id, name, currency, language, active listing count) |
| `GET /api/etsy/shop/readiness` | Phase readiness flags (sync vs publish) |

No Etsy write/publish APIs are called yet.

---

## Next phase: Shop Data Sync

**Goal:** Pull read-only shop/catalog metadata into ListJetGo DB for dashboard use.

Planned work (not implemented):

- Scheduled or on-demand sync jobs
- Persist shop profile + listing summaries in Postgres
- Panel “Shop overview” section fed from sync tables
- Error handling + `last_synced_at` on accounts

**Prerequisite:** Connected shop + `GET /api/etsy/shop/readiness` returns `shopDataSyncReady: true`.

---

## Later phases (out of scope today)

| Phase | Scope |
|-------|--------|
| Listing publish | Create/update Etsy listings from ListJetGo dispatch |
| Order sync | Import Etsy orders / transactions |
| Tracking sync | Push tracking to Etsy fulfillments |
| Billing | Usage metering / plan limits |

Do not implement these until Shop Data Sync is stable.

---

## Known limitations

- No listing publish, order sync, tracking, or billing
- Single `WORKSPACE_ID` env (no multi-user auth refactor)
- PKCE pending state still in-memory (multi-instance caveat)
- Etsy public OAuth may require Etsy support activation
