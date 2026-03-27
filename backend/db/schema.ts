export const Tables = {
  WORKSPACES: "workspaces",
  STORES: "stores",
  ASIN_REGISTRY: "asin_registry",
  IMPORT_BATCHES: "import_batches",
  ASIN_POOL: "asin_pool",
  STORE_CATALOG_STATE: "store_catalog_state",
  LISTING_HISTORY: "listing_history",
  DELETION_HISTORY: "deletion_history",
  SCHEDULER_PROFILES: "scheduler_profiles",
  JOBS: "jobs",
  BRAND_BLACKLIST: "brand_blacklist",
  KEYWORD_BLACKLIST: "keyword_blacklist",
  ASIN_LOCKS: "asin_locks",
  AMAZON_PRODUCT_CACHE: "amazon_product_cache",
  AI_LISTING_CACHE: "ai_listing_cache"
} as const

export const Enums = {
  GLOBAL_ASIN_STATUS: "global_asin_status",
  POOL_STATUS: "pool_status",
  PIPELINE_STAGE: "pipeline_stage",
  SCRAPE_STATUS: "scrape_status",
  AI_STATUS: "ai_status",
  LISTING_EXECUTION_STATUS: "listing_execution_status",
  CATALOG_CURRENT_STATUS: "catalog_current_status",
  LISTING_HISTORY_STATUS: "listing_history_status",
  JOB_STATUS: "job_status",
  SCHEDULER_MODE: "scheduler_mode",
  LOCK_REASON: "lock_reason",
  BLACKLIST_MATCH_TYPE: "blacklist_match_type",
  STORE_HEALTH: "store_health",
  SYNC_HEALTH: "sync_health"
} as const

export type TableName = (typeof Tables)[keyof typeof Tables]
export type EnumName = (typeof Enums)[keyof typeof Enums]
