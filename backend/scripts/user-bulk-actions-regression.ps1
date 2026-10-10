# ListJetGo user bulk actions - non-destructive security regression (Phase 5Q / 5R)
# Does NOT run happy-path bulk writes. Safe against admin stores (S4 spoof expects 404).

$ErrorActionPreference = "Continue"
$base = if ($env:LISTJETGO_API_BASE) { $env:LISTJETGO_API_BASE } else { "http://localhost:4000" }

function Show-HttpError {
  param($ErrorRecord)
  if ($ErrorRecord.Exception.Response) {
    Write-Host ("  Status: " + $ErrorRecord.Exception.Response.StatusCode.value__)
    if ($ErrorRecord.ErrorDetails.Message) {
      Write-Host ("  Body: " + $ErrorRecord.ErrorDetails.Message)
    }
  } else {
    Write-Host ("  " + $ErrorRecord.Exception.Message)
  }
}

function Test-ExpectError {
  param(
    [string]$Label,
    [scriptblock]$Call,
    [int[]]$ExpectedStatus
  )
  Write-Host ""
  Write-Host ("=== " + $Label + " ===")
  try {
    $r = & $Call
    Write-Host "  UNEXPECTED OK:" ($r | ConvertTo-Json -Compress -Depth 4)
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($ExpectedStatus -contains $code) {
      Write-Host ("  PASS (" + $code + ")")
    } else {
      Write-Host ("  FAIL expected [" + ($ExpectedStatus -join ',') + "] got " + $code)
      Show-HttpError $_
    }
  }
}

Write-Host ("ListJetGo bulk actions regression - " + $base)
Write-Host "Non-destructive only (no happy-path bulk writes)."

$endpoints = @(
  @{ path = "/app/stock-alerts/bulk-ignore"; body = '{"storeCode":"S4","alertIds":[1],"confirm":true}' },
  @{ path = "/app/listings/bulk-stock-guard"; body = '{"storeCode":"S4","catalogStateIds":[1],"enabled":true,"confirm":true}' },
  @{ path = "/app/listings/bulk-hide"; body = '{"storeCode":"S4","catalogStateIds":[1],"confirm":true}' },
  @{ path = "/app/stock-alerts/bulk-approve-zero"; body = '{"storeCode":"S4","alertIds":[1],"confirm":true,"confirmationText":"ZERO"}' },
  @{ path = "/app/listings/bulk-end"; body = '{"storeCode":"S4","catalogStateIds":[69673],"confirm":true,"confirmationText":"END"}' }
)

foreach ($ep in $endpoints) {
  Test-ExpectError ("No auth " + $ep.path) {
    Invoke-RestMethod -Uri ($base + $ep.path) -Method POST -ContentType "application/json" -Body $ep.body
  } -ExpectedStatus @(401)
}

Write-Host ""
Write-Host "=== Login testuser ==="
try {
  $login = Invoke-RestMethod -Uri ($base + "/auth/login") -Method POST -ContentType "application/json" `
    -Body '{"email":"testuser@gmail.com","password":"StrongPass123!"}'
  $token = $login.token
  Write-Host "  Token acquired"
} catch {
  Write-Host "  FAIL login (is PostgreSQL up?)"
  Show-HttpError $_
  exit 1
}
$headers = @{ Authorization = ("Bearer " + $token) }

foreach ($ep in $endpoints) {
  Test-ExpectError ("S4 spoof " + $ep.path) {
    Invoke-RestMethod -Uri ($base + $ep.path) -Method POST -ContentType "application/json" -Headers $headers -Body $ep.body
  } -ExpectedStatus @(404, 403)
}

Test-ExpectError "bulk-ignore confirm missing" {
  Invoke-RestMethod -Uri ($base + "/app/stock-alerts/bulk-ignore") -Method POST -ContentType "application/json" -Headers $headers `
    -Body '{"storeCode":"S1","alertIds":[1]}'
} -ExpectedStatus @(400)

Test-ExpectError "bulk-stock-guard enabled missing" {
  Invoke-RestMethod -Uri ($base + "/app/listings/bulk-stock-guard") -Method POST -ContentType "application/json" -Headers $headers `
    -Body '{"storeCode":"S1","catalogStateIds":[1],"confirm":true}'
} -ExpectedStatus @(400)

Test-ExpectError "bulk-hide empty ids" {
  Invoke-RestMethod -Uri ($base + "/app/listings/bulk-hide") -Method POST -ContentType "application/json" -Headers $headers `
    -Body '{"storeCode":"S1","catalogStateIds":[],"confirm":true}'
} -ExpectedStatus @(400)

Test-ExpectError "bulk-approve-zero wrong ZERO" {
  Invoke-RestMethod -Uri ($base + "/app/stock-alerts/bulk-approve-zero") -Method POST -ContentType "application/json" -Headers $headers `
    -Body '{"storeCode":"S1","alertIds":[1],"confirm":true,"confirmationText":"ZEROX"}'
} -ExpectedStatus @(400)

Test-ExpectError "bulk-approve-zero quantity body" {
  Invoke-RestMethod -Uri ($base + "/app/stock-alerts/bulk-approve-zero") -Method POST -ContentType "application/json" -Headers $headers `
    -Body '{"storeCode":"S1","alertIds":[1],"confirm":true,"confirmationText":"ZERO","quantity":0}'
} -ExpectedStatus @(400)

$b51 = @{ storeCode = "S1"; alertIds = @(1..51); confirm = $true } | ConvertTo-Json
Test-ExpectError "bulk-ignore 51 ids" {
  Invoke-RestMethod -Uri ($base + "/app/stock-alerts/bulk-ignore") -Method POST -ContentType "application/json" -Headers $headers -Body $b51
} -ExpectedStatus @(400, 404)

$b51c = @{ storeCode = "S1"; catalogStateIds = @(1..51); enabled = $true; confirm = $true } | ConvertTo-Json
Test-ExpectError "bulk-stock-guard 51 ids" {
  Invoke-RestMethod -Uri ($base + "/app/listings/bulk-stock-guard") -Method POST -ContentType "application/json" -Headers $headers -Body $b51c
} -ExpectedStatus @(400, 404)

$b11 = @{ storeCode = "S1"; alertIds = @(1..11); confirm = $true; confirmationText = "ZERO" } | ConvertTo-Json
Test-ExpectError "bulk-approve-zero 11 ids" {
  Invoke-RestMethod -Uri ($base + "/app/stock-alerts/bulk-approve-zero") -Method POST -ContentType "application/json" -Headers $headers -Body $b11
} -ExpectedStatus @(400, 404)

Test-ExpectError "S1 not owned bulk-hide" {
  Invoke-RestMethod -Uri ($base + "/app/listings/bulk-hide") -Method POST -ContentType "application/json" -Headers $headers `
    -Body '{"storeCode":"S1","catalogStateIds":[1],"confirm":true}'
} -ExpectedStatus @(404)

Test-ExpectError "bulk-end confirm missing" {
  Invoke-RestMethod -Uri ($base + "/app/listings/bulk-end") -Method POST -ContentType "application/json" -Headers $headers `
    -Body '{"storeCode":"S1","catalogStateIds":[1],"confirmationText":"END"}'
} -ExpectedStatus @(400)

Test-ExpectError "bulk-end wrong END" {
  Invoke-RestMethod -Uri ($base + "/app/listings/bulk-end") -Method POST -ContentType "application/json" -Headers $headers `
    -Body '{"storeCode":"S1","catalogStateIds":[1],"confirm":true,"confirmationText":"ENDX"}'
} -ExpectedStatus @(400)

Test-ExpectError "bulk-end empty ids" {
  Invoke-RestMethod -Uri ($base + "/app/listings/bulk-end") -Method POST -ContentType "application/json" -Headers $headers `
    -Body '{"storeCode":"S1","catalogStateIds":[],"confirm":true,"confirmationText":"END"}'
} -ExpectedStatus @(400)

Test-ExpectError "bulk-end quantity body" {
  Invoke-RestMethod -Uri ($base + "/app/listings/bulk-end") -Method POST -ContentType "application/json" -Headers $headers `
    -Body '{"storeCode":"S1","catalogStateIds":[1],"confirm":true,"confirmationText":"END","quantity":0}'
} -ExpectedStatus @(400)

Test-ExpectError "bulk-end price body" {
  Invoke-RestMethod -Uri ($base + "/app/listings/bulk-end") -Method POST -ContentType "application/json" -Headers $headers `
    -Body '{"storeCode":"S1","catalogStateIds":[1],"confirm":true,"confirmationText":"END","price":9.99}'
} -ExpectedStatus @(400)

$b11c = @{ storeCode = "S1"; catalogStateIds = @(1..11); confirm = $true; confirmationText = "END" } | ConvertTo-Json
Test-ExpectError "bulk-end 11 ids" {
  Invoke-RestMethod -Uri ($base + "/app/listings/bulk-end") -Method POST -ContentType "application/json" -Headers $headers -Body $b11c
} -ExpectedStatus @(400, 404)

Test-ExpectError "S1 not owned bulk-end" {
  Invoke-RestMethod -Uri ($base + "/app/listings/bulk-end") -Method POST -ContentType "application/json" -Headers $headers `
    -Body '{"storeCode":"S1","catalogStateIds":[1],"confirm":true,"confirmationText":"END"}'
} -ExpectedStatus @(404)

Write-Host ""
Write-Host "=== Admin GET regression (no write) ==="
$adminPaths = @(
  "/admin/monitor/listings?storeCode=S4",
  "/admin/stock-alerts",
  "/admin/stock-guard/settings?storeCode=S4",
  "/admin/settings?storeCode=S4"
)
foreach ($path in $adminPaths) {
  try {
    $resp = Invoke-WebRequest -Uri ($base + $path) -Method GET -UseBasicParsing
    Write-Host ("  " + $path + " -> " + $resp.StatusCode)
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    Write-Host ("  " + $path + " -> " + $code)
  }
}

Write-Host ""
Write-Host "=== Activity log (read-only) ==="
Test-ExpectError "activity no auth" {
  Invoke-RestMethod -Uri ($base + "/app/activity") -Method GET
} -ExpectedStatus @(401)

try {
  $activity = Invoke-RestMethod -Uri ($base + "/app/activity?page=1&limit=50") -Method GET -Headers $headers
  Write-Host "  activity list -> 200 items:" ($activity.items.Count)
  $adminActions = @($activity.items | Where-Object { $_.action -like "admin.*" })
  if ($adminActions.Count -eq 0) {
    Write-Host "  PASS no admin.* actions in response"
  } else {
    Write-Host "  FAIL admin actions leaked:" ($adminActions.Count)
  }
} catch {
  Write-Host "  activity list failed"
  Show-HttpError $_
}

Test-ExpectError "activity S4 spoof" {
  Invoke-RestMethod -Uri ($base + "/app/activity?storeCode=S4") -Method GET -Headers $headers
} -ExpectedStatus @(404)

Test-ExpectError "activity bad action filter" {
  Invoke-RestMethod -Uri ($base + "/app/activity?action=bad") -Method GET -Headers $headers
} -ExpectedStatus @(400)

try {
  $inj = Invoke-RestMethod -Uri ($base + "/app/activity?q=' OR 1=1 --") -Method GET -Headers $headers
  Write-Host "  activity q injection -> 200 (safe empty or filtered)"
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Write-Host ("  activity q injection -> " + $code)
}

Write-Host ""
Write-Host "Done. Happy-path bulk writes: run manually on an owned test store only."
Write-Host "See docs/USER_BULK_ACTIONS_REGRESSION.md"
