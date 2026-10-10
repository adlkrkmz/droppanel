# Etsy listing publish plan

Dry-run mapping only — **no Etsy write API calls** in this phase.

Related: [ETSY_NEXT_STEPS.md](./ETSY_NEXT_STEPS.md), [ETSY_OAUTH_ENV.md](./ETSY_OAUTH_ENV.md)

---

## Etsy fields required (createDraftListing / publish)

| Etsy field | Required | Notes |
|------------|----------|-------|
| `title` | Yes | Max 140 chars |
| `description` | Yes | Rich text / HTML depending on API path |
| `price` | Yes | Amount + currency |
| `quantity` | Yes | ≥ 1 |
| `taxonomy_id` | Yes | Etsy category taxonomy node |
| `who_made` | Yes | `i_did`, `collective`, `someone_else` |
| `when_made` | Yes | e.g. `made_to_order`, `2020_2025` |
| `is_supply` | Yes | Boolean — craft supply vs finished good |
| `shipping_profile_id` | Yes | Etsy shop shipping profile |
| `return_policy_id` | Often | Shop return policy |
| `type` | Yes | `physical` or `download` |
| Listing images | Yes | Etsy **listing_image_id** after upload — not raw URL at publish |
| `tags` | Recommended | Up to 13 |
| `materials` | Recommended | Up to 13 |

---

## Our internal draft model → Etsy mapping

**Draft source:** `asin_pool.id` (= `draftId` in dry-run API)

| Internal (ListJetGo) | Source table/field | Etsy target | Status |
|----------------------|-------------------|-------------|--------|
| Title | `ai_listing_cache.title` → payload | `title` | Mapped |
| Description | Template + AI bullets | `description` | Mapped |
| Price | `amazon_product_cache.price` + markup | `price.amount` | Mapped (USD assumed) |
| Quantity | `store_settings.default_quantity` / default 1 | `quantity` | Mapped |
| Images | `amazon_product_cache.images` | `image_urls` (preview) → **listing_image_id** later | Partial |
| Tags | Not stored | `tags` | **Missing UI** |
| Materials | `item_specifics.Material` if present | `materials` | Partial |
| Category | `attributes.category` (Amazon) | `taxonomy_id` | **Not mapped** |
| who_made | — | `who_made` | **Missing** |
| when_made | — | `when_made` | **Missing** |
| is_supply | — | `is_supply` | **Missing** |
| Shipping profile | — (eBay uses `fulfillment_policy_id`) | `shipping_profile_id` | **Missing** |
| Return policy | eBay `return_policy_id` only | `return_policy_id` | **Missing Etsy IDs** |
| Shop OAuth | `etsy_accounts` | connection + token | Mapped (readiness) |

**Mapper:** `modules/etsyListings/etsyListingPayloadMapper.ts`  
**Function:** `buildEtsyListingDraftPayload(productDraft, shopContext)`

---

## Missing UI / data fields (blocks real publish)

1. **Etsy taxonomy picker** (`taxonomy_id`)
2. **who_made / when_made / is_supply** selectors
3. **Etsy shipping profile picker** (distinct from eBay fulfillment policy)
4. **Etsy return policy picker**
5. **Tags editor** (up to 13)
6. **Materials editor**
7. **Image upload to Etsy** (listing_image_id) — we only have source URLs today
8. **Currency** — hardcoded `USD` in dry-run preview

---

## Dry-run checklist

```http
POST /api/etsy/listings/dry-run
Content-Type: application/json

{ "draftId": 123 }
```

**Response (safe JSON):**

- `canPublish` — false until all required checks pass
- `readinessScore` — 0–100
- `missingRequiredFields` — blocking items
- `warnings` — non-blocking gaps
- `payloadPreview` — what we *would* send (no Etsy call)
- `shopConnected`, `shopId`, `shopName`

**Panel:** Pool page → **Etsy readiness** on a row (uses `poolId` as `draftId`).

Manual verification:

1. Connected Etsy shop in Settings
2. Pool row with title, description, price, images
3. Dry-run returns score + missing list
4. No Etsy write traffic in network/logs

---

## Next phases

| Phase | Scope |
|-------|--------|
| **A — Taxonomy picker** | Map/search Etsy taxonomy; store `taxonomy_id` on draft |
| **B — Shipping profile picker** | List Etsy shop shipping profiles; persist selection |
| **C — Image upload mapping** | Upload images → `listing_image_id` |
| **D — Create draft listing** | `POST` Etsy createDraftListing (still unpublished) |
| **E — Publish listing** | Activate listing on Etsy after final verification |

---

## What blocks real publish today

- No Etsy taxonomy/category selection
- No Etsy-specific listing attributes (`who_made`, `when_made`, `is_supply`)
- No Etsy shipping/return profile IDs
- No Etsy image upload pipeline
- Dry-run explicitly does **not** call Etsy write APIs
- Publish button disabled in UI with tooltip until Phase E

---

## Known limitations

- `draftId` = `asin_pool.id` only (variation products not yet supported)
- Currency fixed to USD in preview
- eBay store settings are not Etsy settings
- No listing publish, order sync, tracking, or billing
