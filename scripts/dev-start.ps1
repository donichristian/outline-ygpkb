# Start Outline for local development (Windows, no Docker/WSL).
#
#   .\scripts\dev-start.ps1
#
# Prerequisites: PostgreSQL 17 service running, Redis running (see
# docs/TECHNICAL-GUIDE.md). Run from an ordinary (non-elevated) shell.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$redisRoot = 'C:\redis\Redis-8.10.2-Windows-x64-msys2-with-Service'

# --- 1. Redis -------------------------------------------------------------
# RedisService.exe must be started from the folder holding the binaries and
# config; MSYS2 resolves the config argument relative to the current directory.
if (-not (Get-Process redis-server -ErrorAction SilentlyContinue)) {
  if (Test-Path "$redisRoot\redis-server.exe") {
    Start-Process -FilePath "$redisRoot\redis-server.exe" `
      -ArgumentList 'redis-dev.conf' -WorkingDirectory $redisRoot -WindowStyle Hidden
    Start-Sleep -Seconds 4
    Write-Host "redis:  $(& "$redisRoot\redis-cli.exe" PING)"
  } else {
    Write-Warning "Redis not found at $redisRoot - start it manually."
  }
}

# --- 2. Backend -----------------------------------------------------------
# dev:watch normally sets NODE_ENV inline, which cmd.exe cannot parse, and
# build.js shells out to rm/cp/mkdir, which need Git Bash as ComSpec.
# Set NODE_ENV in the shell instead and compile with ComSpec pointed at bash.
$env:NODE_ENV = 'development'
$env:ComSpec = 'C:\PROGRA~1\Git\bin\bash.exe'

Write-Host 'building server...'
node build.js

# Restore the normal shell so yarn keeps working in this session.
$env:ComSpec = $env:SystemRoot\System32\cmd.exe

Write-Host 'starting backend and vite...'
yarn dev:watch