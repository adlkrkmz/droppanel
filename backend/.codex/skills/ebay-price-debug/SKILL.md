---
name: ebay-price-debug
description: Trace and debug ListJetGo eBay source-price, profit-protection, manual price-update, and live listing price problems. Use when source price, calculated target, panel price, Inventory offer price, or buyer-visible eBay price disagree or a price update fails.
---

Trace the complete eBay price chain for the exact affected listing.

Always identify:

- ASIN
- store
- catalog_state_id
- eBay itemId
- SKU
- offerId if applicable

Trace:

1. Source evidence
   - Keepa/Oxylabs/current verified source
   - source price
   - source timestamp

2. Accepted source persistence
   - store_catalog_state.source_price
   - persistence timestamp
   - exact write path

3. Pricing
   - current pricing rule
   - target price
   - decision timestamp
   - do not change pricing formulas unless explicitly requested

4. eBay mutation
   - method/endpoint
   - account/store identity
   - item/SKU/offer mapping
   - HTTP status
   - eBay Ack/error
   - per-item bulk result if available

5. Authoritative success check
   - Trading GetItem buyer-visible price is the final success authority where this flow applies
   - Inventory offer readback alone is not success
   - local ebay_price must not be persisted as success before authoritative confirmation

6. Manual price-update path
   - trace separately if manual update is affected
   - determine whether it shares the same service or failure path

7. Failure classes
   distinguish:
   - source not persisted
   - pricing decision not created
   - wrong store/account identity
   - wrong SKU/offer/item mapping
   - provider 4xx
   - provider 429/5xx
   - Inventory/live Trading divergence
   - Trading revise failure
   - local false success
   - retry/idempotency failure

8. Never weaken store/account ownership guards.
9. Never manually edit local price just to make state match.
10. Never treat HTTP 200 as business success without checking eBay-level result.
11. Preserve mutation receipts/audit evidence.
12. For live regressions, fix the general path before historical reconciliation.

Final report:

SOURCE_STATE
PRICING_STATE
MUTATION_STATE
TRADING_LIVE_STATE
ROOT_CAUSE
EXACT_CODE_PATH
SAFE_MINIMAL_FIX
