# DropPanel Runbook

## Senaryo 1: Queue Çalışmıyor
**Belirtiler:** Telegram'dan "Queue Takıldı" uyarısı geldi, ürünler işlenmiyor.

**Adımlar:**
1. Extension'ı kontrol et — Chrome'da DropPanel aktif mi?
2. Backend terminalinde hata var mı bak
3. DB'deki takılı job'ları temizle:
psql -U postgres -d droppanel -c "UPDATE dispatch_jobs SET status='failed' WHERE status IN ('claimed','pending') AND updated_at < NOW() - INTERVAL '15 minutes';"
4. Backend restart et: `start-postgres.bat` çalıştır
5. Extension reload et: chrome://extensions → DropPanel → Reload

---

## Senaryo 2: Scraper Fail
**Belirtiler:** Telegram'dan "Scraper Fail Spike" uyarısı geldi.

**Adımlar:**
1. Amazon'da bir ürün sayfasını manuel aç, extension çalışıyor mu test et
2. Extension console'unu kontrol et: chrome://extensions → DropPanel → Service Worker
3. Amazon bot koruması devreye girmiş olabilir — 30 dakika bekle
4. Failed job'ları resetle:
psql -U postgres -d droppanel -c "UPDATE dispatch_jobs SET status='pending', attempt_count=0 WHERE status='failed' AND created_at > NOW() - INTERVAL '1 hour';"

---

## Senaryo 3: Publish Çalışmıyor
**Belirtiler:** Telegram'dan "Publish Başarısız" uyarısı geldi.

**Adımlar:**
1. eBay token kontrol et — Telegram'da "Token Süresi Doluyor" uyarısı var mı?
2. Settings sayfasında store'u kontrol et, token yenile
3. Rate limit mi? — 15 dakika bekle
4. eBay Seller Hub'da hesap durumunu kontrol et: https://www.ebay.com/sh/overview
5. Sorunlu ASIN'i skipped yap:
psql -U postgres -d droppanel -c "UPDATE asin_pool SET status='skipped' WHERE id=POOL_ID;"

---

## Senaryo 4: DB Gitti
**Belirtiler:** Telegram'dan "Health Check Başarısız - PostgreSQL" uyarısı geldi.

**Adımlar:**
1. PostgreSQL'i başlat: `start-postgres.bat` çalıştır
2. Bağlantı test et:
psql -U postgres -d droppanel -c "SELECT 1;"
3. Hala çalışmıyorsa backup'tan restore et:
psql -U postgres -c "DROP DATABASE droppanel;"
psql -U postgres -c "CREATE DATABASE droppanel;"
psql -U postgres -d droppanel -f "C:\Users\pc\Desktop\ebay listing\backups[EN_SON_BACKUP].sql"
4. Backend restart et

---

## Acil Komutlar

### Backend restart
cd "C:\Users\pc\Desktop\ebay listing"
start-postgres.bat

### Tüm job'ları temizle
psql -U postgres -d droppanel -c "UPDATE dispatch_jobs SET status='failed' WHERE status IN ('claimed','pending');"

### Pool durumu
psql -U postgres -d droppanel -c "SELECT pipeline_stage, status, COUNT(*) FROM asin_pool GROUP BY pipeline_stage, status;"

### Son hatalar
psql -U postgres -d droppanel -c "SELECT asin, last_error, updated_at FROM dispatch_jobs WHERE status='failed' ORDER BY updated_at DESC LIMIT 10;"
