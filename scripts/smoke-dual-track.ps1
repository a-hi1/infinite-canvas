# Dual-track smoke: page must stay up when api is stopped; then restore api.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\smoke-dual-track.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\smoke-dual-track.ps1 -BaseUrl http://127.0.0.1:3011
param(
  [string]$ComposeFile = "docker-compose.local.yml",
  [string]$BaseUrl = "http://127.0.0.1:3011"
)

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Fail = 0

function Note([string]$m) { Write-Host $m }
function Ok([string]$m) { Write-Host "[OK] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Bad([string]$m) { Write-Host "[FAIL] $m" -ForegroundColor Red; $script:Fail++ }

Note "== dual-track smoke =="
Note "compose: $ComposeFile"
Note "base: $BaseUrl"
Note ""

Note "-- baseline --"
try {
  $page = Invoke-WebRequest -Uri "$BaseUrl/" -UseBasicParsing -TimeoutSec 8
  if ($page.StatusCode -eq 200) { Ok "page up before stop" } else { Bad "page status $($page.StatusCode)" }
} catch {
  Bad "page request failed before stop: $($_.Exception.Message)"
}
try {
  $h = Invoke-WebRequest -Uri "$BaseUrl/api/health" -UseBasicParsing -TimeoutSec 8
  if ($h.StatusCode -eq 200) { Ok "api health up before stop" } else { Warn "api health status $($h.StatusCode)" }
} catch {
  Warn "api health not reachable before stop (stack may already be partial)"
}
Note ""

Note "-- stop api --"
docker compose -f $ComposeFile stop api
if ($LASTEXITCODE -ne 0) { Bad "docker compose stop api failed" }
Start-Sleep -Seconds 2

Note "-- while api down --"
try {
  $pageDown = Invoke-WebRequest -Uri "$BaseUrl/" -UseBasicParsing -TimeoutSec 8
  if ($pageDown.StatusCode -eq 200) { Ok "page still 200 with api stopped (static/local track)" } else { Bad "page status with api down: $($pageDown.StatusCode)" }
} catch {
  Bad "page failed with api stopped: $($_.Exception.Message)"
}
try {
  $apiDown = Invoke-WebRequest -Uri "$BaseUrl/api/health" -UseBasicParsing -TimeoutSec 5
  if ($apiDown.StatusCode -ge 500) { Ok "api health returns $($apiDown.StatusCode) while stopped (expected)" }
  else { Warn "api health unexpected status while stopped: $($apiDown.StatusCode)" }
} catch {
  Ok "api health unreachable while stopped (expected)"
}
Note ""

Note "-- start api --"
docker compose -f $ComposeFile start api
if ($LASTEXITCODE -ne 0) { Bad "docker compose start api failed" }
Start-Sleep -Seconds 3

try {
  $h2 = Invoke-WebRequest -Uri "$BaseUrl/api/health" -UseBasicParsing -TimeoutSec 10
  if ($h2.StatusCode -eq 200 -and $h2.Content -match '"ok"\s*:\s*true') { Ok "api health restored" }
  else { Bad "api health not ok after start: $($h2.Content)" }
} catch {
  Bad "api health failed after start: $($_.Exception.Message)"
}

Note ""
Note "Manual still required: unauthenticated generate image/canvas/assets/prompts while api stopped."
Note ""

if ($Fail -gt 0) {
  Bad "finished with $Fail failure(s)"
  exit 1
}
Ok "dual-track smoke finished with no hard failures"
exit 0
