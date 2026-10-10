# User bulk actions — regression checklist (Phase 5Q / 5R / 5S)

Non-destructive security and validation tests for `/app/*` bulk write endpoints.  
**Do not run happy-path bulk writes against admin stores (S4/S6/S8).**  
Happy-path tests require an owned user test store and manual confirmation.

## Prerequisites

- **PostgreSQL** running (`localhost:5432` or `DATABASE_URL` in `.env`)
- **Backend** on port 4000
- **Panel** optional for UI checks (port 3000 typical)

### Start backend

```powershell
cd "C:\Users\pc\Desktop\ebay listing\backend"
npx ts-node server.ts
```

### Start panel (optional)

```powershell
cd "C:\Users\pc\Desktop\ebay listing\backend\panel"
npm run dev
```

### Test user login

```powershell
$login = Invoke-RestMethod -Uri "http://localhost:4000/auth/login" `
  -Method POST -ContentType "application/json" `
  -Body '{"email":"testuser@gmail.com","password":"StrongPass123!"}'
$token = $login.token
$headers = @{ Authorization = "Bearer $token" }
```

### Automated non-destructive script

```powershell
cd "C:\Users\pc\Desktop\ebay listing\backend"
powershell -NoProfile -File .\scripts\user-bulk-actions-regression.ps1
```

Optional: `$env:LISTJETGO_API_BASE = "http://localhost:4000"`

---

## Bulk endpoint limits (verified)

| Endpoint | Max IDs | confirm | Extra validation | eBay write |
|----------|---------|---------|------------------|------------|
| `POST /app/stock-alerts/bulk-ignore` | 50 | `true` | — | No |
| `POST /app/listings/bulk-stock-guard` | 50 | `true` | `enabled` boolean | No |
| `POST /app/listings/bulk-hide` | 50 | `true` | — | No |
| `POST /app/stock-alerts/bulk-approve-zero` | 10 | `true` | `confirmationText` = `"ZERO"`, `quantity` rejected | **Yes** |
| `POST /app/listings/bulk-end` | no max (chunked) | `true` | eBay End success → hard-delete catalog row; fail keeps row | **Yes** |

Duplicate IDs are **deduped** before processing (not 400).  
`ebayItemId` in bulk-end body is **ignored** (resolved from DB).

---

## Security tests (all endpoints)

### 1. No auth → 401

```powershell
Invoke-RestMethod -Uri "http://localhost:4000/app/stock-alerts/bulk-ignore" `
  -Method POST -ContentType "application/json" `
  -Body '{"storeCode":"S4","alertIds":[1],"confirm":true}'
# Repeat for bulk-stock-guard, bulk-hide, bulk-approve-zero, bulk-end
```

Expected: **401** Unauthorized

### 2. testuser + S4 spoof → 404

```powershell
Invoke-RestMethod -Uri "http://localhost:4000/app/stock-alerts/bulk-ignore" `
  -Method POST -ContentType "application/json" -Headers $headers `
  -Body '{"storeCode":"S4","alertIds":[1,2],"confirm":true}'
```

Expected: **404** Store not found (or 403).  
**S4 must not change.** No eBay API calls for approve-zero spoof.

### 3. testuser + S1 when not owned → 404

Use any bulk body with `"storeCode":"S1"` when testuser has no S1 store.

Expected: **404** Store not found

---

## Per-endpoint validation tests

### bulk-ignore

| Test | Body hint | Expected |
|------|-----------|----------|
| confirm missing | no `confirm` | 400 |
| confirm false | `"confirm":false` | 400 |
| alertIds empty | `[]` | 400 |
| alertIds not array | `"alertIds":"1"` | 400 |
| invalid id | `[0,-1,"x"]` | 400 |
| 51 unique ids | `1..51` | 400 must not exceed 50 |
| duplicate ids | `[1,1,2]` | dedupe; 404 if no store |

### bulk-stock-guard

| Test | Expected |
|------|----------|
| catalogStateIds empty | 400 |
| enabled missing | 400 |
| enabled not boolean | 400 |
| 51 catalogStateIds | 400 |
| confirm missing/false | 400 |

### bulk-hide

| Test | Expected |
|------|----------|
| catalogStateIds empty | 400 |
| 51 catalogStateIds | 400 |
| confirm missing/false | 400 |

### bulk-approve-zero

| Test | Expected |
|------|----------|
| confirmationText wrong | 400 |
| confirm missing/false | 400 |
| 11 alertIds | 400 must not exceed 10 |
| quantity in body | 400 Quantity is not accepted |
| alertIds empty / invalid | 400 |

### bulk-end

| Test | Expected |
|------|----------|
| confirmationText wrong | 400 |
| confirm missing/false | 400 |
| catalogStateIds empty | 400 |
| catalogStateIds not array | 400 |
| invalid catalogStateIds | 400 |
| 11 catalogStateIds | 400 must not exceed 10 |
| duplicate catalogStateIds | deduped; 404 if no store |
| quantity in body | 400 Quantity is not accepted |
| price in body | 400 Price is not accepted |
| ebayItemId in body | ignored (DB resolve) |

Non-destructive auth/spoof samples:

```powershell
# No auth -> 401
Invoke-RestMethod -Uri "http://localhost:4000/app/listings/bulk-end" `
  -Method POST -ContentType "application/json" `
  -Body '{"storeCode":"S4","catalogStateIds":[69673],"confirm":true,"confirmationText":"END"}'

# testuser + S4 spoof -> 404 (S4 must not change, no eBay call)
Invoke-RestMethod -Uri "http://localhost:4000/app/listings/bulk-end" `
  -Method POST -ContentType "application/json" -Headers $headers `
  -Body '{"storeCode":"S4","catalogStateIds":[69673],"confirm":true,"confirmationText":"END"}'
```

---

## DB safety checks (after S4 spoof tests)

### Stock alerts unchanged

```sql
SELECT id, store_id, workspace_id, review_status, ignored_at, action_error, updated_at
FROM stock_review_items
WHERE id IN (1, 2);
```

Compare before/after — no changes expected.

### S4 listing unchanged

```sql
SELECT scs.id, s.store_code, scs.ebay_item_id, scs.panel_hidden_at, scs.stock_guard_enabled,
       scs.ebay_quantity, scs.current_status, scs.updated_at
FROM store_catalog_state scs
JOIN stores s ON s.id = scs.store_id
WHERE s.store_code = 'S4'
  AND scs.id = 69673;
```

Compare before/after — no changes expected after S4 spoof.

### Bulk end audit (after happy-path only)

```sql
SELECT action, target_type, target_id, metadata, created_at
FROM audit_logs
WHERE action LIKE 'app.bulk.listings.end%'
   OR action LIKE 'app.listings.end%'
ORDER BY created_at DESC
LIMIT 20;
```

### Batch audit trail

```sql
SELECT action, target_type, target_id, metadata, created_at
FROM audit_logs
WHERE action LIKE 'app.bulk.%'
ORDER BY created_at DESC
LIMIT 30;
```

Success batch metadata should include: `workspaceId`, `storeCode`, `batchId`, `requested`, `succeeded`, `failed`, `actorUserId`.  
Per-item audits should include `batchId` when part of a bulk batch.  
Must **not** contain tokens, secrets, raw eBay responses, or stack traces.

---

## Admin regression checklist

```powershell
Invoke-WebRequest -Uri "http://localhost:4000/admin/monitor/listings?storeCode=S4" -UseBasicParsing
Invoke-WebRequest -Uri "http://localhost:4000/admin/stock-alerts" -UseBasicParsing
Invoke-WebRequest -Uri "http://localhost:4000/admin/stock-guard/settings?storeCode=S4" -UseBasicParsing
Invoke-WebRequest -Uri "http://localhost:4000/admin/settings?storeCode=S4" -UseBasicParsing
```

Expected: endpoints respond without 500 regressions from user bulk work.  
Note: some admin routes require admin JWT/session; document actual status codes for your env.

Also verify unchanged admin flows:

- `POST /admin/stock-alerts/ignore`
- `POST /admin/listings/remove-from-list`
- Admin approve-zero / stock guard paths

---

## Happy-path manual tests (skip if no owned store)

Only on a **user-owned test store** with pending stock alerts / listings:

1. Select ≤50 listings → Enable/Disable Guard → verify `stock_guard_enabled` in DB
2. Select ≤50 listings → Hide → verify `panel_hidden_at` set; eBay unchanged
3. Select ≤10 eligible listings → End with typed **END** → verify `current_status = ended`, `ebay_quantity = 0`, `panel_hidden_at` unchanged
4. Select ≤50 alerts → Ignore → verify `review_status = ignored`
5. Select ≤10 eligible alerts (not PRICE_INCREASE) → Set Qty 0 with typed ZERO → verify eBay qty 0 + alert actioned

**Skip** if testuser has no stores or `EBAY_SIMULATION` blocks live writes.

---

## UI checklist

### `/app/listings` toolbar

- Export Selected, Enable/Disable Guard, Hide selected, **End selected** active
- Guard/Hide disabled when eligible count > **50**
- End enabled for any eligible count ≥ **1** (no max batch size)
- Hide: copy states this does not end eBay listings
- Guard: copy states monitoring-only change
- End: simple Yes/No confirm; eBay success → hard-delete from ListJetGo

### `/app/stock-alerts` toolbar

- Export, Ignore, Set Qty 0 selected active
- Set Qty 0 disabled when eligible > **10**
- PRICE_INCREASE excluded with clear copy

### Bulk result modals

- Summary: Requested / Succeeded / Failed
- Outcome line: all success / partial / all failed (standard copy)
- Optional short batch ref (first 8 chars of batchId)

---

## Activity Log (Phase 5S — read-only)

```powershell
# No auth -> 401
Invoke-RestMethod -Uri "http://localhost:4000/app/activity" -Method GET

# testuser -> 200, app.* only, workspace scoped
Invoke-RestMethod -Uri "http://localhost:4000/app/activity?page=1&limit=50" `
  -Method GET -Headers @{ Authorization = "Bearer $token" }

# S4 storeCode spoof -> 404
Invoke-RestMethod -Uri "http://localhost:4000/app/activity?storeCode=S4" `
  -Method GET -Headers @{ Authorization = "Bearer $token" }

# invalid action filter -> 400
Invoke-RestMethod -Uri "http://localhost:4000/app/activity?action=bad" `
  -Method GET -Headers @{ Authorization = "Bearer $token" }

# SQL injection attempt -> safe (no data leak)
Invoke-RestMethod -Uri "http://localhost:4000/app/activity?q=' OR 1=1 --" `
  -Method GET -Headers @{ Authorization = "Bearer $token" }
```

Expected:

- Response items must **not** include `action` starting with `admin.`
- Metadata must not contain token/secret/raw response fields
- Bulk batch audits (`app.bulk.*`) visible when present in user workspace
- `action=bulk` returns only `app.bulk.%` actions

---

## Build verification

```powershell
cd "C:\Users\pc\Desktop\ebay listing\backend"
npx tsc --noEmit

cd "C:\Users\pc\Desktop\ebay listing\backend\panel"
npm run build
```
