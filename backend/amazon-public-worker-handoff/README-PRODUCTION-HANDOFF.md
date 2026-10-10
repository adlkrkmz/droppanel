# Public Amazon Worker — Production Handoff

Bu paket, local `amazon-research-lab` içinde **500 gerçek ASIN** testinde çalışan public Amazon browser/parser davranışının **değiştirilmeden kopyalanmış** kaynaklarıdır.

- Queue / Stock Guard / business karar mantığı **yoktur**.
- Research-lab UI, Keepa, orchestrator, SQLite, CSV **yoktur**.
- Bu paket production’a bağlanmaz; sadece kopyalanacak çalışan parçaları taşır.

---

## 1. Dosya envanteri

| Dosya | İşlev |
|-------|--------|
| `src/amazon-worker.ts` | **PUBLIC_BROWSER_ENTRY.** Playwright Chromium (persistent profile), `https://www.amazon.com/dp/{asin}?th=1` navigasyonu, DOM snapshot extraction (`page.evaluate`), challenge tespiti, parse + classify çağrıları. |
| `src/parsing.ts` | **PUBLIC_PARSER_ENTRY.** `parseAmazonSnapshot`, `classifyAmazonObservation`, `challengeReason`, `extractAsin` ve snapshot → observation helper’ları. *(Aynı dosyada Keepa helper’ları da vardır; Amazon public path bunları kullanmaz — dosya bilinçli olarak refactor edilmedi.)* |
| `src/types.ts` | `WorkerName`, `AppConfig` (worker’ın ihtiyaç duyduğu config tipleri). |
| `src/config.ts` | `config/config.json` yükleyici (`loadConfig`). |
| `config/config.example.json` | Public worker için gereken config alanları örneği. |
| `scripts/playwright-local.cjs` | `PLAYWRIGHT_BROWSERS_PATH=0` preload (workspace-local Chromium). |
| `tsconfig.json` | Lab ile aynı TS derleme ayarları. |

### Bilinçli olarak hariç tutulan bağımlılık

`amazon-worker.ts` research-lab’tan `./db` (`logEvent`, `updateItem`) import eder. **SQLite / `db.ts` bu pakete kopyalanmadı.** Production entegrasyonunda:

- Browser snapshot + `parseAmazonSnapshot` + `classifyAmazonObservation` **aynen korunmalı**.
- `logEvent` / `updateItem` persistence hook’ları production sink’ine bağlanmalı (parser/browser davranışı değiştirilmeden).

---

## 2. Input

| Alan | Açıklama |
|------|----------|
| **requested ASIN** | `AmazonWorker.observe(asin: string)` — tek girdi. URL: `https://www.amazon.com/dp/{asin}?th=1` |

---

## 3. Output contract

Observation (`AmazonObservation` in `parsing.ts`) + classify sonucu + input ASIN:

| Alan | Kaynak |
|------|--------|
| `requestedAsin` | Input ASIN (`observe` argümanı) |
| `actualAsin` | `AmazonObservation.actualAsin` |
| `pageExists` | `AmazonObservation.pageExists` |
| `status` | `classifyAmazonObservation(observation, requestedAsin)` |
| `offerCondition` | `AmazonObservation.offerCondition` (`NEW` \| `RESALE` \| `USED` \| `LIKE_NEW` \| `RENEWED` \| `UNKNOWN`) |
| `newOfferAvailable` | `AmazonObservation.newOfferAvailable` |
| `mainPrice` | `AmazonObservation.mainPrice` |
| `primeMemberPrice` | `AmazonObservation.primeMemberPrice` |
| `regularPrice` | `AmazonObservation.regularPrice` |
| `prime` | Kod alanı: **`primeVisible`** (`boolean \| null`) |
| `shipsFrom` | `AmazonObservation.shipsFrom` |
| `soldBy` | `AmazonObservation.soldBy` |
| `availability` | `AmazonObservation.availability` |
| `finalUrl` | `AmazonObservation.finalUrl` |

Ek observation alanları (aynı parser’dan): `inStock`, `offerLabel`.

Worker sonuç türü (`AmazonResult`): `{ kind: 'done' \| 'technical' \| 'challenge'; reason?: string }`.

---

## 4. Status değerleri

Parser classify (`classifyAmazonObservation`):

| Status | Anlam |
|--------|--------|
| `AMAZON_CHECKED` | `newOfferAvailable === true` |
| `ASIN_MISMATCH_OBSERVED` | `actualAsin !== requestedAsin` |
| `OUT_OF_STOCK_OBSERVED` | `newOfferAvailable === false` **ve** `inStock === false` |
| `NEW_OFFER_UNAVAILABLE` | Resale/used/like-new/renewed **veya** `newOfferAvailable === false` (OOS dışı) |
| `PRODUCT_NOT_FOUND_OBSERVED` | `pageExists === false` |
| `AMAZON_INCOMPLETE` | ASIN yok veya new-offer kararı verilemiyor |

Technical / challenge (worker + lab orchestrator mapping; orchestrator bu pakette yok):

| Durum | Kaynak |
|-------|--------|
| `kind: 'challenge'` | `challengeReason(...)` eşleşmesi (captcha, robot check, access denied, …) — lab’da `AMAZON_CHALLENGE_PAUSED` |
| `kind: 'technical'` | Navigasyon/Playwright exception — lab’da `AMAZON_TECHNICAL_FAILED` |

---

## 5. Playwright / browser gereksinimleri

- **Dependency:** `playwright` (lab: `^1.55.0`)
- **Browser:** Chromium via `chromium.launchPersistentContext`
- **Profile dir (lab convention):** `data/browser-profiles/amazon-{A|B|C}` — **profile/cookie kopyalanmaz**; runtime’da oluşur
- **Headless:** `config.amazonHeadless` (lab default: `false`)
- **Timeout:** `config.navigationTimeout` (lab default: `30000`)
- **Preload:** `node -r ./scripts/playwright-local.cjs …` → `PLAYWRIGHT_BROWSERS_PATH=0`
- **Node:** `>=22` (lab `package.json` engines)

---

## 6. Ne kopyalanmalı / ne lab’a özel

### Production’a kopyalanacak (bu paket)

- `amazon-worker.ts` (browser + inline snapshot extraction)
- `parsing.ts` Amazon path: `parseAmazonSnapshot`, `classifyAmazonObservation`, `challengeReason`, `extractAsin` (+ aynı dosyadaki private helpers)
- `types.ts` / `config.ts` / config alanları örneği
- `scripts/playwright-local.cjs` (veya eşdeğer env)

### Research-lab’a özel — kopyalamayın

- `db.ts` / SQLite / `data/research.sqlite*`
- `orchestrator.ts` (queue, failover loop, retry/challenge pause orchestration)
- `keepa-worker.ts` / Keepa akışı
- `server.ts` + `public/*` UI panel
- CSV export, ASIN test datasetleri, loglar
- `node_modules`, `dist`, browser profiles/cookies

---

## 7. Bu pakette OLMAYAN production parçaları

Açıkça:

- **Queue / claim / scheduling** yok
- **Stock Guard** yok
- **Business karar mantığı** (satın al / tut / fiyat kuralı vb.) yok
- **Production API / auth / secrets** yok

Bu paket yalnızca: **requested ASIN → public Amazon sayfası gözlemi → observation + status**.

Üst katman (queue, Stock Guard, business rules) production’da kalır; bu worker’ın output contract’ını tüketir.
