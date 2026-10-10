# Local Amazon Browser Worker watchdog.
# Starts the existing worker from backend cwd (same .env, profile dir, queue).
# Restarts on crash. Does not change worker/Keepa/Stock Guard logic.

$ErrorActionPreference = "Continue"
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$backend = Split-Path -Parent $scriptDir
Set-Location -LiteralPath $backend

$nodeDir = Join-Path $env:ProgramFiles "nodejs"
if (Test-Path -LiteralPath $nodeDir) {
  $env:Path = "$nodeDir;$env:Path"
}

$logDir = Join-Path $backend "var"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "amazon-browser-worker-watchdog.log"
$node = Join-Path $nodeDir "node.exe"
$tsNode = Join-Path $backend "node_modules\ts-node\dist\bin.js"

function Write-WatchdogLog([string]$msg) {
  $line = "$(Get-Date -Format o) $msg"
  try { Add-Content -LiteralPath $log -Value $line -Encoding utf8 } catch { }
}

function Get-AmazonWorkerPids {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'amazon-browser-worker\.ts' } |
    Select-Object -ExpandProperty ProcessId
}

Write-WatchdogLog "watchdog start cwd=$backend node=$node"

if (-not (Test-Path -LiteralPath $node)) {
  Write-WatchdogLog "FATAL node.exe missing"
  Start-Sleep -Seconds 30
  exit 1
}
if (-not (Test-Path -LiteralPath $tsNode)) {
  Write-WatchdogLog "FATAL ts-node missing at $tsNode"
  Start-Sleep -Seconds 30
  exit 1
}

while ($true) {
  $existing = @(Get-AmazonWorkerPids)
  if ($existing.Count -gt 0) {
    Write-WatchdogLog "already running pids=$($existing -join ',') - waiting"
    Start-Sleep -Seconds 15
    continue
  }

  Write-WatchdogLog "starting amazon-browser-worker"
  & $node $tsNode --transpile-only (Join-Path $backend "amazon-browser-worker.ts")
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 1 }
  Write-WatchdogLog "exited code=$code - restart in 8s"
  Start-Sleep -Seconds 8
}
