# Production backend deploy runbook

This is the production standard for `/home/listjetgo/app/backend` on the
ListJetGo server. It is intentionally a stop-the-line runbook: do not replace
an unknown code source, do not expose `.env`, and do not run a release swap
while another PM2 process still executes files from the live backend tree.

## Verified production contract

- Backend path: `/home/listjetgo/app/backend`
- API PM2 process: `listjetgo-api`
- API launch contract: `node_modules/.bin/ts-node server.ts`, with
  `NODE_ENV=production`
- Health endpoint: `http://127.0.0.1:4000/health`
- Production database credentials are available to the application through
  `/home/listjetgo/app/backend/.env`; the API also has `DATABASE_URL` in its
  PM2 environment. The `.env` file is parsed by Node `dotenv`, never shell
  sourced. Never print either value.
- `package-lock.json` and `node_modules/` are in the backend tree.
- Persistent paths in the current tree include `.env`, `var/`, and `backups/`.
  `var/` contains browser profiles and operational artifacts and must not be
  discarded or copied while its owning workers are running.
- The backend is **not** a Git checkout. A deploy source must therefore be
  supplied and attested at deploy time.

## Prerequisites and stop gates

Run as `listjetgo` on the production server. Set the following non-secret
values for the release only:

```bash
export RELEASE_ID='YYYYMMDD-HHMMSS'
export DEPLOY_SOURCE='/absolute/path/to/the-approved-tested-backend-tree'
export STAGE="/home/listjetgo/deploy-staging/backend-${RELEASE_ID}"
export RELEASE="/home/listjetgo/releases/backend-${RELEASE_ID}"
export PREVIOUS="/home/listjetgo/releases/backend-pre-${RELEASE_ID}"
```

Before any mutation, prove the source and runtime conditions:

```bash
test -d "$DEPLOY_SOURCE"
test -f "$DEPLOY_SOURCE/package-lock.json"
test -f "$DEPLOY_SOURCE/server.ts"
pm2 jlist
pm2 describe listjetgo-api
df -h /home/listjetgo/app/backend /home/listjetgo/releases
```

Stop if the supplied source is not the tested artifact, if free space is
insufficient for a second backend tree plus dependencies, or if any other PM2
process has `pm_cwd`, `pm_exec_path`, or arguments below
`/home/listjetgo/app/backend`. There is no verified worker-release procedure
yet; a full directory swap is prohibited until those processes are separately
stopped/released under an approved worker runbook.

## Backup and rollback position

Create a preserved code release directory before the swap. Do not overwrite an
existing `PREVIOUS` directory.

Migration 081 is additive: it creates one table and inserts an idempotent
singleton row. Application rollback may leave this table in place; **do not
drop it automatically**. Before the migration, take a schema-only backup of
the affected table name (if it exists) and retain the normal production backup
under the release identifier. A database restore is only considered for a
separate, approved data-recovery incident.

The established production backup tooling uses `pg_dump "$DATABASE_URL"`. For
this additive migration, a full database rollback backup is not required for
ordinary application rollback, but the deploy operator must either verify a
current normal backup or create one before the release:

```bash
cd /home/listjetgo/app/backend
mkdir -p "/home/listjetgo/backups/backend-${RELEASE_ID}"
node -r dotenv/config -e 'const {spawnSync}=require("node:child_process"); const u=new URL(process.env.DATABASE_URL||""); const env={...process.env,PGHOST:u.hostname,PGPORT:u.port||"5432",PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGSSLMODE:u.searchParams.get("sslmode")||process.env.PGSSLMODE}; const r=spawnSync("pg_dump",["-Fc","-f",process.argv[1]],{stdio:"inherit",env}); process.exit(r.status ?? 1)' \
  "/home/listjetgo/backups/backend-${RELEASE_ID}/predeploy.dump"
```

PM2 rollback is a code rollback followed by the same verified API restart
command. Preserve the former tree at `PREVIOUS` until all health and controlled
validation gates pass.

## Stage and hash gate

The source method is an approved, externally supplied tested backend tree.
Neither Git, rsync, nor scp is currently established as the source of truth.
Record its provenance outside this runbook before continuing.

Create the staging tree without copying production secrets or runtime state:

```bash
mkdir -p /home/listjetgo/deploy-staging /home/listjetgo/releases
test ! -e "$STAGE" && test ! -e "$RELEASE" && test ! -e "$PREVIOUS"
mkdir "$STAGE"
cp -a "$DEPLOY_SOURCE/." "$STAGE/"
rm -f "$STAGE/.env"
rm -rf "$STAGE/var" "$STAGE/backups" "$STAGE/node_modules"
cp -a /home/listjetgo/app/backend/.env "$STAGE/.env"
chmod 600 "$STAGE/.env"
cd "$STAGE"
npm ci
```

The three `rm` commands above are permitted only after `STAGE` has been
assigned as shown and verified not to be a live/release path. They remove only
the just-created staging copies, never the live paths.

For this release, hash the exact runtime files before staging and verify the
same bytes in staging and after the swap:

```bash
FILES=(
  modules/oxylabsVerify/oxylabsProductNormalize.ts
  modules/oxylabsVerify/oxylabsProductDecision.ts
  modules/oxylabsVerify/oxylabsApplyOperations.ts
  modules/oxylabsVerify/oxylabsVerifyApply.ts
  migrations/081_oxylabs_zero_stock_kill_switch.sql
)
(cd "$DEPLOY_SOURCE" && sha256sum "${FILES[@]}") > "$STAGE/required-sha256.txt"
(cd "$STAGE" && sha256sum -c required-sha256.txt)
```

Any missing file or checksum mismatch is a stop condition.

## Migration 081

`migrations/081_oxylabs_zero_stock_kill_switch.sql` is independent of migration
080. It is transaction-safe: `CREATE TABLE IF NOT EXISTS` and `INSERT ... ON
CONFLICT DO NOTHING` are transactional PostgreSQL statements. Re-running it
leaves the existing table and singleton unchanged. `ON_ERROR_STOP=1` prevents
continuation after an error; `-1` additionally makes this two-statement file a
single transaction.

Expected result: `public.oxylabs_zero_stock_kill_switch` has exactly one row
with `singleton=true`, `consecutive_successes=0`, `reserved_slots=0`, and
`active=false`. Creation takes the normal brief DDL lock; no migration-080
table is referenced.

Precheck (read-only):

```bash
cd /home/listjetgo/app/backend
node -r dotenv/config -e 'const {spawnSync}=require("node:child_process"); const u=new URL(process.env.DATABASE_URL||""); const env={...process.env,PGHOST:u.hostname,PGPORT:u.port||"5432",PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGSSLMODE:u.searchParams.get("sslmode")||process.env.PGSSLMODE}; const r=spawnSync("psql",["-v","ON_ERROR_STOP=1","-t","-A","-c","SELECT to_regclass(\x27public.oxylabs_zero_stock_kill_switch\x27) IS NULL AS absent;"],{stdio:"inherit",env}); process.exit(r.status ?? 1)'
```

Standard migration command (execute only after precheck says `t`):

```bash
cd /home/listjetgo/app/backend
node -r dotenv/config -e 'const {spawnSync}=require("node:child_process"); const u=new URL(process.env.DATABASE_URL||""); const env={...process.env,PGHOST:u.hostname,PGPORT:u.port||"5432",PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGSSLMODE:u.searchParams.get("sslmode")||process.env.PGSSLMODE}; const r=spawnSync("psql",["-v","ON_ERROR_STOP=1","-1","-f","/home/listjetgo/app/backend/migrations/081_oxylabs_zero_stock_kill_switch.sql"],{stdio:"inherit",env}); process.exit(r.status ?? 1)'
```

Postcheck (read-only):

```bash
node -r dotenv/config -e 'const {spawnSync}=require("node:child_process"); const u=new URL(process.env.DATABASE_URL||""); const env={...process.env,PGHOST:u.hostname,PGPORT:u.port||"5432",PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGSSLMODE:u.searchParams.get("sslmode")||process.env.PGSSLMODE}; const r=spawnSync("psql",["-v","ON_ERROR_STOP=1","-t","-A","-c","SELECT count(*)=1 AND bool_and(singleton) AND min(consecutive_successes)=0 AND max(consecutive_successes)=0 AND min(reserved_slots)=0 AND max(reserved_slots)=0 AND bool_and(active=false) FROM public.oxylabs_zero_stock_kill_switch;"],{stdio:"inherit",env}); process.exit(r.status ?? 1)'
```

The expected postcheck output is `t`. Failure, any nonzero counter, or an
active kill switch stops the release. Keep the additive table during a code
rollback unless a separately approved database recovery plan says otherwise.

## Release swap

Only after the worker-path gate above passes, prepare the new release with
runtime paths preserved explicitly:

```bash
test -f "$STAGE/.env"
test ! -e "$RELEASE"
mv "$STAGE" "$RELEASE"
mv /home/listjetgo/app/backend "$PREVIOUS"
mv "$RELEASE" /home/listjetgo/app/backend
cd /home/listjetgo/app/backend
sha256sum -c required-sha256.txt
```

This is the established release-preservation/swap pattern. It deliberately
does not claim that copying `var/` is safe. If `var/` must remain live, stop
and use an approved worker/runtime preservation plan before this step.

## PM2 restart and health

No environment change is part of this release; therefore do **not** add
`--update-env`. The verified restart command is:

```bash
pm2 describe listjetgo-api
pm2 restart listjetgo-api
pm2 describe listjetgo-api
curl -sS -o /dev/null -w "API_LOCAL=%{http_code}\\n" http://127.0.0.1:4000/health
pm2 logs listjetgo-api --lines 80 --nostream
```

Proceed only if PM2 is `online`, the health result is `API_LOCAL=200`, and the
health payload reports both database and API as `ok`. A module-load error,
non-200 health result, or database failure triggers rollback.

## Rollback

- **Before the swap:** remove only the verified staging directory; no service
  change is needed.
- **Migration failure:** stop immediately. Do not swap code and do not run
  another migration command.
- **Swap/restart/health failure:** move the failed live tree to a uniquely
  named failed-release directory, move `PREVIOUS` back to
  `/home/listjetgo/app/backend`, verify its hashes/required files, then run
  `pm2 restart listjetgo-api` and the local health check.
- **Migration 081 already succeeded:** leave its additive table in place while
  rolling back code. Do not issue a drop statement automatically.
- **Any zero-stock operation before controlled validation:** stop; do not
  reprocess further ASINs. Preserve logs and investigate before any retry.

## Controlled post-deploy validation

First perform deployed **read-only classification** of exactly these ASINs:

- `B0HCNFYQ8H` → `NO_VERIFIED_NEW_FBA_OFFER`
- `B0DX25128F` → `NO_VERIFIED_NEW_FBA_OFFER`
- `B00WQY9PHW` → `NO_VERIFIED_NEW_FBA_OFFER`
- `B0GGHNZL3D` → `USED_OR_RESALE`

Only after all four classifications match may the existing guarded flow
reprocess those same four ASINs. Do not run a full-catalog reprocess. Any
mismatch, provider error, unexpected operation, or kill-switch state mismatch
is an incident stop condition.

## Targeted TypeScript Hot Deploy — API-only changes

This method is allowed only when all changed runtime files are explicitly
listed, every import resolves in the existing production tree, there are no
`package.json`, lockfile, environment, generated-artifact, panel, worker, or
runtime-state changes, and the release changes are consumed only by
`listjetgo-api`. It is the preferred method for the current Oxylabs policy
change because the API runs `ts-node server.ts` directly and imports the
Oxylabs apply processor at API startup. No JavaScript build output is used.

Do not use this method for a new package, an environment change, a worker or
panel change, a file under `var/`, a generated artifact, or an import that is
not already present in the live tree. Those changes require an approved
full-release/worker procedure.

The deploy operator must provide an approved, tested source root in
`SOURCE_ROOT`. It must be distinct from the live tree for a normal copy deploy.
If the approved bytes are already staged in the live tree, do **not** copy a
file onto itself; record and verify the manifest, then continue with migration
and restart only.

```bash
export RELEASE_ID='YYYYMMDD-HHMMSS'
export SOURCE_ROOT='/absolute/path/to/approved-tested-source'
export LIVE_ROOT='/home/listjetgo/app/backend'
export BACKUP_ROOT="/home/listjetgo/releases/oxylabs-source-policy-${RELEASE_ID}"
FILES=(
  modules/oxylabsVerify/oxylabsProductNormalize.ts
  modules/oxylabsVerify/oxylabsProductDecision.ts
  modules/oxylabsVerify/oxylabsApplyOperations.ts
  modules/oxylabsVerify/oxylabsVerifyApply.ts
)
MIGRATION='migrations/081_oxylabs_zero_stock_kill_switch.sql'

test -d "$SOURCE_ROOT"
for f in "${FILES[@]}" "$MIGRATION"; do test -f "$SOURCE_ROOT/$f"; done
test ! -e "$BACKUP_ROOT"
mkdir -p "$BACKUP_ROOT/files"
(cd "$SOURCE_ROOT" && sha256sum "${FILES[@]}" "$MIGRATION") > "$BACKUP_ROOT/approved-sha256.txt"
(cd "$SOURCE_ROOT" && sha256sum -c "$BACKUP_ROOT/approved-sha256.txt")
(cd "$LIVE_ROOT" && cp --parents --preserve=mode,ownership,timestamps "${FILES[@]}" "$BACKUP_ROOT/files/")
(cd "$BACKUP_ROOT/files" && sha256sum "${FILES[@]}") > "$BACKUP_ROOT/predeploy-sha256.txt"
```

The backup contains only the four replaced TypeScript files. The migration is
included in the approved manifest but is not backed up as code; it remains an
additive database change under the migration section above.

Prevent the API from loading a partial replacement while files are copied:

```bash
pm2 stop listjetgo-api
(cd "$SOURCE_ROOT" && cp --parents --preserve=mode,ownership,timestamps "${FILES[@]}" "$LIVE_ROOT/")
(cd "$LIVE_ROOT" && sha256sum -c "$BACKUP_ROOT/approved-sha256.txt" --ignore-missing)
pm2 restart listjetgo-api
pm2 describe listjetgo-api
curl -sS -o /dev/null -w "API_LOCAL=%{http_code}\\n" http://127.0.0.1:4000/health
pm2 logs listjetgo-api --lines 80 --nostream
```

The destination verification uses the approved manifest and checks the four
runtime files; it intentionally ignores the migration entry because copying a
migration is not part of this targeted code step. Run the migration precheck,
single-file migration command, and postcheck from the Migration 081 section
separately.

If the restart, module load, database health, or API health check fails, restore
only the backed-up files and verify their recorded hashes before restarting:

```bash
pm2 stop listjetgo-api
(cd "$BACKUP_ROOT/files" && cp --parents --preserve=mode,ownership,timestamps "${FILES[@]}" "$LIVE_ROOT/")
(cd "$LIVE_ROOT" && sha256sum -c "$BACKUP_ROOT/predeploy-sha256.txt")
pm2 restart listjetgo-api
curl -sS -o /dev/null -w "API_LOCAL=%{http_code}\\n" http://127.0.0.1:4000/health
```

Leave migration 081 in place during this code rollback. A non-200 health
response, non-online PM2 status, hash mismatch, unexpected zero-stock
operation, or failed controlled four-ASIN classification is an immediate stop
condition.
