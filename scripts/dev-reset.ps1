# Spin up the Outline local dev server fast: clean up any stale
# dev processes, then start a verified server on 3050/3051.
#
#   .\scripts\dev-reset.ps1
#
# Safe to run while a server is already up - it stops the current stack,
# re-spawns it, and verifies HTTP responses before returning.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$apiPort  = 3050
$vitePort = 3051

Write-Host '== stopping existing dev processes =='
$doomed = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object {
    $_.CommandLine -match 'vite\.js|nodemon|concurrently|build/server/index\.js|scripts/dev\.js' -or
    $_.CommandLine -match 'corepack.*yarn\.js.*(dev:watch|dev:backend|vite|concurrently)'
  }
if ($doomed) {
  $doomed | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Write-Host "  stopped $($doomed.Count) process(es)"
} else {
  Write-Host '  none'
}

# Give OS a moment to release the sockets
Start-Sleep -Seconds 4

Write-Host '== waiting for ports to clear =='
$busy = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -eq $apiPort -or $_.LocalPort -eq $vitePort }
if ($busy) {
  # Last-ditch kill the process that still owns the port
  foreach ($b in $busy) {
    $owner = Get-Process -Id $b.OwningProcess -ErrorAction SilentlyContinue
    if ($owner) { try { Stop-Process -Id $b.OwningProcess -Force -ErrorAction Stop } catch {} }
  }
  Start-Sleep -Seconds 3
}
$still = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -eq $apiPort -or $_.LocalPort -eq $vitePort }
if ($still) {
  Write-Warning "Port(s) still in use after cleanup: $($still.LocalPort -join ', ')"
  exit 1
}

Write-Host ''
Write-Host '== starting dev server (first run compiles ~2 min) =='
# Detach via WMI so it survives this script returning
$cmd = 'cmd /c "cd /d ' + $repo + '&& yarn dev:start > C:\Users\Media\AppData\Local\Temp\opencode\live-dev.log 2>&1"'
$launched = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
if ($launched.ReturnValue -ne 0) {
  Write-Error "Failed to launch dev server (Win32 rc=$($launched.ReturnValue))"
  exit 1
}

Write-Host "  launched pid=$($launched.ProcessId), booting..."
Start-Sleep -Seconds 210

Write-Host '== verifying =='
function Get-StatusCode([string]$url, [switch]$follow) {
  $args = @('-s', '-o', 'NUL', '-w', '%{http_code}', '-m', '20')
  if ($follow) { $args += '-L' }
  $args += $url
  return & curl.exe @args 2>&1
}

$code3050 = Get-StatusCode "http://localhost:$apiPort/"
$code3051 = Get-StatusCode "http://localhost:$vitePort/"
$codeFollow = Get-StatusCode "http://localhost:$vitePort/" -follow

Write-Host "  http://localhost:$apiPort/ -> $code3050"
Write-Host "  http://localhost:$vitePort/ -> $code3051"
Write-Host "  http://localhost:$vitePort/ (followed) -> $codeFollow"

if ($code3050 -ne '200' -and $code3050 -ne '000') {
  Write-Host ''
  Write-Host '== recent log lines =='
  Get-Content 'C:\Users\Media\AppData\Local\Temp\opencode\live-dev.log' -Tail 20 -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host "Unexpected HTTP $code3050 on port $apiPort" -ForegroundColor Yellow
  exit 1
}

Write-Host ''
Write-Host "Dev server ready at http://localhost:$apiPort" -ForegroundColor Green
Write-Host 'Stopping it later: stop the node processes listed under scripts/dev:stop'