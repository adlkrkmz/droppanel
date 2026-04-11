-- dispatch_jobs tablosuna job_type kolonu ekle
-- scrape_and_list: validated ürünler — worker scrape + AI + done
-- ai_and_list:     scraped ürünler  — worker sadece AI + done
-- list_only:       ai_generated     — worker direkt done (listing panel tarafından yapılır)
ALTER TABLE dispatch_jobs
  ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'scrape_and_list';
