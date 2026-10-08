# Stop the local dev server started by dev-reset.ps1.
#
#   .\scripts\dev-stop.ps1
#
# Kills every node process that belongs to the Outline dev stack
# (vite, nodemon, concurrently, the Koa backend, our dev:start launcher).
# Nothing else running is affected.

$ErrorActionPreference = 'Continue'

Write-Host '== stopping Outline dev stack =='
$doomed = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object {
    $_.CommandLine -match 'vite\.js|nodemon|concurrently|build/server/index\.js|scripts/dev\.js' -or
    $_.CommandLine -match 'corepack.*yarn\.js.*(dev:watch|dev:backend|vite|concurrently)'
  }

if (-not $doomed) {
  Write-Host '  no dev processes found - nothing to stop'
  exit 0
}

foreach ($p in $doomed) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
}
Write-Host "  stopped $($doomed.Count) process(es)"

Start-Sleep -Seconds 3

$busy = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 3050,3051 }
if ($busy) {
  $busy | ForEach-Object {
    $owner = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    if ($owner) { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop } catch {} }
  }
  Start-Sleep -Seconds 3
}

$remaining = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 3050,3051 }
if ($remaining) {
  Write-Warning "Ports still in use: $($remaining.LocalPort -join ', ')"
  exit 1
}

Write-Host '== clean =='
Write-Host 'Ports 3050 and 3051 are free. Start again with .\scripts\dev-reset.ps1'