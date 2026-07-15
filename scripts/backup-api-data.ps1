# Backup cloud API data directory (JSON db + uploads) on Windows.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\backup-api-data.ps1
param(
  [string]$DataDir = "",
  [string]$BackupDir = "",
  [int]$KeepBackups = 14
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $DataDir) { $DataDir = Join-Path $Root "data\api" }
if (-not $BackupDir) { $BackupDir = Join-Path $Root "backups\api" }

if (-not (Test-Path $DataDir)) {
  throw "data dir not found: $DataDir"
}

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Target = Join-Path $BackupDir "api-data-$Stamp.zip"

Compress-Archive -Path (Join-Path $DataDir "*") -DestinationPath $Target -Force
Write-Host "backup written: $Target"

$Old = Get-ChildItem -Path $BackupDir -Filter "api-data-*.zip" | Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepBackups
foreach ($Item in $Old) {
  Remove-Item -Force $Item.FullName
}
if ($Old) {
  Write-Host "pruned old backups, keep=$KeepBackups"
}
