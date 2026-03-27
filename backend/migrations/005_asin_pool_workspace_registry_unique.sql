-- One pool row per workspace + ASIN registry (required for ON CONFLICT upsert from product extractor)
DELETE FROM asin_pool a
USING asin_pool b
WHERE a.workspace_id = b.workspace_id
  AND a.asin_registry_id = b.asin_registry_id
  AND a.id > b.id;

CREATE UNIQUE INDEX uq_asin_pool_workspace_registry
ON asin_pool (workspace_id, asin_registry_id);
