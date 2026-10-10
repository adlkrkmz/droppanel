---
name: ebay-api-trace
description: Trace ListJetGo eBay API calls across Trading, Inventory, Fulfillment, and related services. Use when an eBay request succeeds at HTTP level but fails at business level, when ownership/mapping is unclear, or when the wrong API path may be used.
---

Read AGENTS.md first.

For the exact operation identify:

- store/account
- marketplace
- itemId
- SKU
- offerId if applicable
- orderId if applicable

Trace:

1. Which eBay API family is used:
   - Trading
   - Inventory
   - Fulfillment
   - other
2. Exact endpoint or call name.
3. Request payload summary.
4. HTTP status.
5. eBay Ack/business status.
6. eBay error code/category/message.
7. Per-item/bulk result if applicable.
8. Request/correlation ID if available.
9. Readback/verification step.
10. Final local persistence.
11. Retry classification.
12. Ownership/store mapping validation.

Rules:

- HTTP 200 does not prove business success.
- Inventory state is not automatically buyer-visible Trading state.
- Do not weaken identity guards.
- Do not change API family just to make a request pass without proving listing model compatibility.
- Preserve receipts/audit evidence.

Final report:

API_FAMILY
ENDPOINT
REQUEST_STATE
HTTP_RESULT
EBAY_BUSINESS_RESULT
READBACK_RESULT
LOCAL_PERSISTENCE_RESULT
ROOT_CAUSE
SAFE_MINIMAL_FIX
