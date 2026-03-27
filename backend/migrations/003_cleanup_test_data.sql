BEGIN;
DELETE FROM listing_history;
DELETE FROM ai_listing_cache;
DELETE FROM amazon_product_cache;
DELETE FROM asin_pool;
DELETE FROM asin_registry;
COMMIT;

