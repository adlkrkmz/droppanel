# listjetgo-keepa-collector 1.0.15

Keepa change sensor + local ASIN registry for the scraper host.
Does **not** talk to PostgreSQL or eBay. Browser workers stay stopped.

1.0.15 adds intentional Stock Guard zero-stock recovery monitoring: ACTIVE recovery-only ASINs are retained at 120h, while shared positive consumers retain the faster 12h/24h cadence.

- a valid Keepa response that omits the requested ASIN is emitted as suspicious identity evidence
- a single-ASIN response with a different returned ASIN preserves that identity evidence
- no additional Keepa endpoint, token, offer, stock, or update request is made

It retains the 1.0.13 self-recovery and cadence-accurate due work:

- ACTIVE due is `last_scanned_at + cadence` (SOLD 12h / STANDARD 24h)
- `next_scan_at` does not block due ACTIVE rows
- PAUSED_QTY_ZERO and REMOVED are not scanned
- repair merge does not inherit a 365-day `next_scan_at`; queue horizon is 48h
- `nextDueAt` drives idle wake; idle sleep is at most 60s
- due/token/reconcile are recomputed every loop
- due work stall uses wall clock: minimum **180s** of no progress, not three short loops
- `SYNC_RECONCILE_MISMATCH`, `TOKEN_WAIT`, and `CADENCE_WAIT` are not stalls
- due work + 180s no progress exits `COLLECTOR_STALLED_DUE_WORK`
- collector API HTTP calls abort after **20s**
- unexpected daemon loop return exits non-zero (`COLLECTOR_LOOP_RETURNED`)
- systemd `Restart=always`, `RestartSec=5`, `StartLimitBurst=20`, `StartLimitIntervalSec=600`
- telemetry: `CADENCE_WAIT`, `TOKEN_WAIT`, `BACKLOG_DRAIN`, `SYNC_REPAIR`, `STALLED`
- operator token reserve 100 (`KEEPA_TOKEN_RESERVE`)
- observation 429/5xx retries via local outbox without a second Keepa query

## Do not swap this host's running collector from this package automatically
This tarball is prepared for operator install. Leave the live collector process running until a later cutover. `KEEPA_DIRECT_MUTATIONS_ENABLED=false`.

## Layout
- `keepa-collector.ts` — process entry (logs version 1.0.14)
- `modules/keepaSensor/` — registry, diff, collector loop, snapshot bootstrap, event catch-up, repair merge, auto-repair, token scheduler, telemetry client
- `modules/globalKeepa/keepaRadarParser.ts` + `modules/keepa/` — existing parser/client (reused)
- `systemd/listjetgo-keepa-collector.service` — unit (`Restart=always`)
- `.env.example` — required names only
- `fixtures/` — auto-repair and daemon cadence fixtures

Local SQLite default: `/var/lib/listjetgo-scan/keepa/keepa-worker.sqlite`

## Required env names (values are operator-supplied; none are shipped)
See `.env.example`. Merge new names into the existing scraper `.env`; do not overwrite secrets.

Telemetry payload may include `nextDueAt`, `lastSchedulerDecisionAt`, `lastProgressAt`, `stallReason`, and `scanMode` (`CADENCE_WAIT` | `TOKEN_WAIT` | `BACKLOG_DRAIN` | `SYNC_REPAIR` | `STALLED`).

## Operator install (manual)
```
sudo mkdir -p /opt/listjetgo-keepa-collector /var/lib/listjetgo-scan/keepa
sudo tar -C /opt/listjetgo-keepa-collector --strip-components=1 -xzf listjetgo-keepa-collector-1.0.14.tar.gz
cd /opt/listjetgo-keepa-collector && npm install --omit=dev
# merge new names into existing .env; do not overwrite secrets
sudo cp systemd/listjetgo-keepa-collector.service /etc/systemd/system/
sudo systemctl daemon-reload
```
