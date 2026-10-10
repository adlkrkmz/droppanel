# Etsy OAuth environment — two projects, do not mix

This document separates Etsy-related environment variables for the **ListJetGo / eBay backend** and the **standalone Etsy automation project**. They are different codebases, ports, callback paths, and databases.

## Where the active Etsy OAuth Connection Manager lives

**Project:** `C:\Users\pc\Desktop\ebay listing\backend`  
**Runtime:** PM2 `droppanel-api` (`server.ts`, port **4000** by default)  
**Module:** `modules/etsyOAuth/`  
**Routes:**

| Route | Purpose |
|-------|---------|
| `GET /api/etsy/connect` | Start OAuth (PKCE) |
| `GET /api/etsy/callback` | Token exchange + DB persist |
| `GET /api/etsy/status` | Safe connection metadata |
| `GET /api/etsy/config` | Public OAuth config (no secrets) |
| `GET /api/etsy/test` | Verify + auto-refresh |
| `POST /api/etsy/disconnect` | Disconnect shop |
| `POST /api/etsy/reconnect` | Start reconnect flow |
| `POST /api/etsy/remove` | Archive/hide shop |

**Etsy panel UI (standalone):** `C:\Users\pc\Desktop\etsy listing\apps\web` → port **3010**  
Calls `${NEXT_PUBLIC_API_URL}/api/etsy/*` (no Etsy secrets in the Etsy frontend).

**eBay panel UI:** `backend/panel` → port **3000** — separate product; do not move Etsy UI there.

The standalone Etsy project at `C:\Users\pc\Desktop\etsy listing` also has a legacy local API (**4010**, callback `/auth/etsy/callback`). **ListJetGo Etsy OAuth does not use that API.**

---

## Which `.env` file to edit (ListJetGo)

| File | Used by | Edit for Etsy OAuth? |
|------|---------|----------------------|
| **`backend/.env`** | `droppanel-api`, worker (`dotenv/config` in `server.ts`) | **Yes — primary file** |
| `backend/panel/.env.local` | Next.js eBay panel only | **No Etsy OAuth vars** — only `NEXT_PUBLIC_API_BASE` |
| `C:\Users\pc\Desktop\etsy listing\.env` | Standalone Etsy web | **`NEXT_PUBLIC_API_URL` only** — points web at shared API |

---

## eBay / ListJetGo backend — required variables

Edit: **`C:\Users\pc\Desktop\ebay listing\backend\.env`**

```env
ETSY_CLIENT_ID=
ETSY_CLIENT_SECRET=
ETSY_REDIRECT_URI=https://api.listjetgo.com/api/etsy/callback
ETSY_AUTH_SUCCESS_REDIRECT=https://etsy.listjetgo.com/settings?etsy=connected
ETSY_AUTH_ERROR_REDIRECT=https://etsy.listjetgo.com/settings?etsy=error
ETSY_SCOPES=shops_r listings_r listings_w transactions_r profile_r
WORKSPACE_ID=<existing workspace uuid>
TOKEN_ENCRYPTION_KEY=<32-byte base64 key>
CORS_ORIGINS=...,http://localhost:3010,https://etsy.listjetgo.com
```

`WORKSPACE_ID` was already present in this backend before Etsy work.

Generate `TOKEN_ENCRYPTION_KEY`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Register in [Etsy Developer](https://www.etsy.com/developers/your-apps) **exact** production callback:

```
https://api.listjetgo.com/api/etsy/callback
```

**Do not change** `ETSY_REDIRECT_URI` when switching Etsy frontend — only update success/error redirects.

---

## Production domain env (api.listjetgo.com + etsy.listjetgo.com)

Use on the server that runs `droppanel-api` and the standalone Etsy web app:

**`backend/.env`:**

```env
ETSY_REDIRECT_URI=https://api.listjetgo.com/api/etsy/callback
ETSY_AUTH_SUCCESS_REDIRECT=https://etsy.listjetgo.com/settings?etsy=connected
ETSY_AUTH_ERROR_REDIRECT=https://etsy.listjetgo.com/settings?etsy=error
```

**Etsy web (`etsy listing/.env` on deploy host):**

```env
NEXT_PUBLIC_API_URL=https://api.listjetgo.com
APP_URL=https://etsy.listjetgo.com
```

**eBay panel (`backend/panel/.env.local` or PM2 env) — unchanged:**

```env
NEXT_PUBLIC_API_BASE=https://api.listjetgo.com
```

---

## Local dev — ListJetGo backend + standalone Etsy web

When running **shared backend** locally (`PORT=4000`) and **Etsy web** locally (`3010`):

**`backend/.env`:**

```env
ETSY_REDIRECT_URI=http://localhost:4000/api/etsy/callback
ETSY_AUTH_SUCCESS_REDIRECT=http://localhost:3010/settings?etsy=connected
ETSY_AUTH_ERROR_REDIRECT=http://localhost:3010/settings?etsy=error
CORS_ORIGINS=http://localhost:3000,http://localhost:3010,...
```

Register in Etsy Developer app (local test app or second callback URL):

```
http://localhost:4000/api/etsy/callback
```

**`etsy listing/.env`:**

```env
NEXT_PUBLIC_API_URL=http://localhost:4000
API_URL=http://localhost:4000
APP_URL=http://localhost:3010
```

Do **not** point ListJetGo Etsy OAuth at `localhost:4010` or `/auth/etsy/callback` — that belongs to the legacy standalone Etsy API.

---

## Standalone Etsy project env (reference)

**Path:** `C:\Users\pc\Desktop\etsy listing\.env`  
**Template:** `C:\Users\pc\Desktop\etsy listing\.env.example`

| Variable | Local dev value |
|----------|-----------------|
| `APP_URL` | `http://localhost:3010` |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` (ListJetGo shared API) |
| `API_URL` | `http://localhost:4000` |
| Legacy `API_PORT` | `4010` (optional; drafts/schedules until migrated) |

OAuth connect button opens: `{NEXT_PUBLIC_API_URL}/api/etsy/connect`  
After OAuth, user lands on: `{APP_URL}/settings?etsy=connected` or `?etsy=error&reason=...`

---

## Quick checklist

1. Etsy Connection Manager code → **`ebay listing/backend`**
2. Set Etsy secrets + redirects → **`backend/.env`**
3. Etsy web API base → **`etsy listing/.env`** (`NEXT_PUBLIC_API_URL`)
4. eBay panel API base → **`panel/.env.local`** (`NEXT_PUBLIC_API_BASE` only)
5. After env changes → `pm2 restart droppanel-api --update-env`

---

## Known limitations (Connection Manager scope)

- No listing publish, order sync, tracking, inventory sync, or billing yet
- `WORKSPACE_ID` single-tenant env (no multi-user auth refactor yet)
- Etsy web drafts/schedules/orders may still expect legacy API on `:4010` until migrated
