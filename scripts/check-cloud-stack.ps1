# Health check for infinite-canvas docker stack on Windows.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\check-cloud-stack.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\check-cloud-stack.ps1 -BaseUrl http://127.0.0.1:3011
param(
  [string]$ComposeFile = "docker-compose.local.yml",
  [string]$BaseUrl = "http://127.0.0.1:3011",
  [switch]$SkipVidgen
)

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Fail = 0

function Note([string]$m) { Write-Host $m }
function Ok([string]$m) { Write-Host "[OK] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Bad([string]$m) { Write-Host "[FAIL] $m" -ForegroundColor Red; $script:Fail++ }

Note "== infinite-canvas cloud stack check (Windows) =="
Note "root: $Root"
Note "compose: $ComposeFile"
Note "base: $BaseUrl"
Note ""

if (Test-Path .git) {
  Note "-- git --"
  try { git log -1 --oneline } catch { Warn "git log failed" }
  Note ""
}

Note "-- compose ps --"
try {
  docker compose -f $ComposeFile ps
  $running = docker compose -f $ComposeFile ps --status running --services 2>$null
  foreach ($svc in @("app", "api", "ai-proxy")) {
    if ($running -contains $svc) { Ok "service running: $svc" } else { Bad "service not running: $svc" }
  }
} catch {
  Bad "docker compose ps failed"
}
Note ""

Note "-- http health --"
try {
  $page = Invoke-WebRequest -Uri "$BaseUrl/" -UseBasicParsing -TimeoutSec 8
  if ($page.StatusCode -eq 200) { Ok "page $BaseUrl/ -> 200" } else { Bad "page status $($page.StatusCode)" }
} catch {
  Bad "page request failed: $($_.Exception.Message)"
}

try {
  $health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec 8
  if ($health.data.ok -eq $true -or $health.ok -eq $true) {
    Ok ("api health ok: " + ($health | ConvertTo-Json -Compress))
  } else {
    Bad ("api health unexpected: " + ($health | ConvertTo-Json -Compress))
  }
} catch {
  # envelope may still be JSON string
  try {
    $raw = (Invoke-WebRequest -Uri "$BaseUrl/api/health" -UseBasicParsing -TimeoutSec 8).Content
    if ($raw -match '"ok"\s*:\s*true') { Ok "api health ok: $raw" } else { Bad "api health unexpected: $raw" }
  } catch {
    Bad "api health request failed: $($_.Exception.Message)"
  }
}
Note ""

Note "-- env hygiene --"
if (Test-Path .env) {
  $envText = Get-Content .env -Raw
  if ($envText -match 'HTTP_PROXY|HTTPS_PROXY') {
    Warn ".env sets HTTP(S)_PROXY (OK for local Clash; avoid copying host:789x to public server)"
  } else {
    Ok ".env present without HTTP(S)_PROXY"
  }
} else {
  Warn "no root .env"
}
Note ""

if (-not $SkipVidgen) {
  Note "-- optional: ai-proxy reachability to vidgen.x.ai --"
  docker compose -f $ComposeFile exec -T ai-proxy wget -q -O /dev/null --timeout=15 https://vidgen.x.ai/ 1>$null 2>$null
  if ($LASTEXITCODE -eq 0) {
    Ok "ai-proxy can reach https://vidgen.x.ai/"
  } else {
    Warn "ai-proxy cannot reach vidgen.x.ai (local BYOK still OK; Grok media/upload-from-url may 502)"
  }
  Note ""
}

Note "-- dual-track reminder --"
Note "Gate: stop api, unauthenticated image/canvas/assets/prompts must still work."
Note ""

if ($Fail -gt 0) {
  Bad "finished with $Fail failure(s)"
  exit 1
}
Ok "finished with no hard failures"
exit 0
