# ListJetGo Oxylabs Amazon Product worker 1.0.2
# PRIMARY slot A or CONFIRM slot C. No Playwright. No amazon_pricing.
# Sequential concurrency=1. One provider call per job.
# Expired owned CLAIMED jobs: resubmit SAVED result or fail OXYLABS_CALL_OUTCOME_UNKNOWN.
# Never a second paid Product call. Worker must be 1.0.2 before API expired-recovery claim is live.

node --version
# >= 24
cp .env.example .env
# Fill LISTJETGO_API_BASE + OXYLABS_VERIFY_WORKER_TOKEN from the API transfer file.
# Fill OXYLABS_API_*_B64 on the scraper host only.
OXYLABS_WORKER_ENABLED=false
OXYLABS_PRICING_ENABLED=false
