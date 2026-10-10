# ListJetGo Amazon public scan worker (remote)

Girişsiz public Amazon okuyucu. Merkez API'den iş alır, gözlemi geri gönderir.
PostgreSQL, eBay OAuth ve login/auth worker bu pakette yoktur.

## Runtime

- Node.js **20+** (hazırlayan makinede doğrulanan: **v24.19.0**)
- Playwright **1.62.1** (Chromium, `npx playwright install chromium` ile)
- Ubuntu 24.04 x86_64 önerilir

## Kurulum (root olmayan kullanıcı)

```bash
sudo useradd --system --home /var/lib/listjetgo-amazon-scan --create-home \
  --shell /usr/sbin/nologin listjetgoscan || true
sudo mkdir -p /opt/listjetgo-amazon-scan /etc/listjetgo-amazon-scan
sudo tar -xzf amazon-scan-worker-1.0.5.tar.gz -C /opt/listjetgo-amazon-scan --strip-components=1
sudo chown -R listjetgoscan:listjetgoscan /opt/listjetgo-amazon-scan /var/lib/listjetgo-amazon-scan
cd /opt/listjetgo-amazon-scan
sudo -u listjetgoscan npm ci
sudo -u listjetgoscan npx playwright install chromium
# Gerekirse sistem kütüphaneleri (bir kez, root):
# sudo npx playwright install-deps chromium
sudo cp .env.example /etc/listjetgo-amazon-scan/worker.env
sudo chmod 640 /etc/listjetgo-amazon-scan/worker.env
sudo chown root:listjetgoscan /etc/listjetgo-amazon-scan/worker.env
# worker.env içine API tabanı, token, ZIP, slot doldurulur. DATABASE_URL yazılmaz.
sudo cp systemd/listjetgo-amazon-scan@.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Profil dizini: `AMAZON_PUBLIC_WORKER_PROFILE_DIR=/var/lib/listjetgo-amazon-scan/profile-A`

## Başlat / durdur

```bash
sudo systemctl enable --now listjetgo-amazon-scan@A
sudo systemctl status listjetgo-amazon-scan@A
sudo journalctl -u listjetgo-amazon-scan@A -f
sudo systemctl stop listjetgo-amazon-scan@A
```

Confirm slot (routine CONFIRM kind) ve Keepa verify (systemd override; bu paket kurulumu A–H açmaz):

```bash
# Slot A = KEEPA_VERIFY_PRIMARY
# /etc/systemd/system/listjetgo-amazon-scan@A.service.d/role.conf
# [Service]
# Environment=AMAZON_SCAN_WORKER_ROLE=KEEPA_VERIFY_PRIMARY
# Environment=AMAZON_PUBLIC_WORKER_SLOT=A

# Slot C = KEEPA_VERIFY_CONFIRM
# /etc/systemd/system/listjetgo-amazon-scan@C.service.d/role.conf
# [Service]
# Environment=AMAZON_SCAN_WORKER_ROLE=KEEPA_VERIFY_CONFIRM
# Environment=AMAZON_PUBLIC_WORKER_SLOT=C
```

Worker ID eşlemesi:

- `AMAZON_SCAN_WORKER_ROLE=ROUTINE` → `amazon-public-browser-worker-<SLOT>` (yalnız ROUTINE)
- `AMAZON_SCAN_WORKER_ROLE=CONFIRM` → `amazon-scan-confirm-<SLOT>` (yalnız CONFIRM)
- `AMAZON_SCAN_WORKER_ROLE=KEEPA_VERIFY_PRIMARY` → `amazon-keepa-verify-primary-<SLOT>`
- `AMAZON_SCAN_WORKER_ROLE=KEEPA_VERIFY_CONFIRM` → `amazon-keepa-verify-confirm-<SLOT>`

`preferConfirm` yalnız sıralamadır; kind yetkisi workerId prefix’inden gelir.

Elle:

```bash
export AMAZON_PUBLIC_WORKER_SLOT=A
./scripts/run-amazon-scan-worker.sh A
```

## Kısa doğrulama (tarayıcı yok)

```bash
unset DATABASE_URL
./node_modules/.bin/ts-node --transpile-only scripts/verify-amazon-scan-worker.ts
```

Canlı kuyruk iddiası: merkez `AMAZON_SCAN_REMOTE_PROTOCOL_ENABLED=true` ve token eşleşmesi gerekir.
Bu paket kurulumu canlı planner/confirm/Keepa flag'lerini açmaz.

## Layout bench (yalnızca bu tarama sunucusunda, kuyruk/eBay yok)

```bash
export AMAZON_PUBLIC_US_ZIP=10001
export AMAZON_SCAN_BENCH_ASINS=XXXXXXXXXX,YYYYYYYYYY
for L in A B C D; do
  AMAZON_SCAN_BENCH_LAYOUT=$L ./node_modules/.bin/ts-node --transpile-only scripts/amazon-scan-layout-bench.ts
done
```

A: 1 browser / 1 context / 1 sekme  
B: 1 browser / 1 context / 2 sekme  
C: 1 browser / 2 context / context başına 1 sekme  
D: 2 browser / ayrı profiller / browser başına 1 sekme  

Başarı = public okuyucunun gözlemi (`kind=done` ve `AMAZON_INCOMPLETE` değil). Yalnızca `page.goto` sayılmaz.

## v1.0.5 Continue shopping interstitial
- Production profile can land on “Click the button below to continue shopping”.
- One visible “Continue shopping” click, then fresh `goto(commit)` to `/dp/<ASIN>?th=1`.
- Real CAPTCHA → fail-closed, no click. Second interstitial → no second click (`AMAZON_INCOMPLETE`).
- Normal PDP is unchanged. `requireFreshNav=true` still closes the context before observe.

## v1.0.1 duraklama
- Hard timeout `open()`+zip+`observe()` zincirini kapsar; in-flight goto `abortOwnedBrowser()` ile kesilir (yalnız bu process’in Chromium PID’i).
- API fetch 12 sn AbortSignal (heartbeat, lease, claim, result, fail).
- Timeout `AMAZON_INCOMPLETE` + retryable fail; VALID/OOS result gitmez.
- Slot outbox: `var/amazon-scan-local-outbox-<SLOT>.jsonl`
- Tempo: `AMAZON_BROWSER_PACE_MS` varsayılan 5000 ms + slot jitter 0–1500 ms (A=0, B=350, …).

## Güvenlik

Pakete `.env`, token, DB, eBay sırları, SSH anahtarı, cookie/profil, `node_modules` ve log konmaz.
`DATABASE_URL` tarama sürecinde silinir.
