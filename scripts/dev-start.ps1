# Start Outline for local development (Windows, no Docker/WSL).
#
#   .\scripts\dev-start.ps1
#
# Requires the PostgreSQL and Redis Windows services to be running, and
# dependencies installed (`corepack enable; yarn install`). See
# docs/TECHNICAL-GUIDE.md for the one-time setup.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$apiPort = 3050
$vitePort = 3051

Write-Host 'Checking services...'
foreach ($svc in 'postgresql-x64-17', 'Redis') {
  $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
  if (-not $s) {
    Write-Warning "Service '$svc' is not installed."
  } elseif ($s.Status -ne 'Running') {
    Write-Warning "Service '$svc' is $($s.Status). Start it with: Start-Service $svc"
  } else {
    Write-Host "  $svc : Running"
  }
}

Write-Host ''
Write-Host "API      http://localhost:$apiPort"
Write-Host "Vite HMR http://localhost:$vitePort/static/"
Write-Host ''
Write-Host 'Starting backend and frontend (first run compiles for ~2 min)...'
Write-Host ''

# yarn dev:watch sets NODE_ENV inline and runs build:server, both of which work
# on Windows: build.js uses node:fs rather than shell commands.
yarn dev:watch