# Verify the Outline local development stack.
#
#   .\scripts\dev-check.ps1
#
# Checks that PostgreSQL, Redis and the built schema are all present.

$ErrorActionPreference = 'Continue'
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
$redisCli = 'C:\redis\Redis-8.10.2-Windows-x64-msys2-with-Service\redis-cli.exe'

function Step($name, $block) {
  Write-Host "`n== $name =="
  & $block
}

Step 'PostgreSQL service' {
  Get-Service postgresql-x64-17 |
    Select-Object Name, Status, StartType | Format-Table -AutoSize
}

Step 'Redis' {
  $svc = Get-Service -Name Redis -ErrorAction SilentlyContinue
  if ($svc) {
    $svc | Select-Object Name, Status, StartType | Format-Table -AutoSize
  }
  if (Get-Process redis-server -ErrorAction SilentlyContinue) {
    & $redisCli PING
    & $redisCli INFO server | Select-String 'redis_version'
  } else {
    Write-Warning 'redis-server is not running'
  }
}

Step 'Dev server ports' {
  $listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -ge 3050 -and $_.LocalPort -le 3100 }

  if ($listening) {
    $listening | Select-Object LocalAddress, LocalPort |
      Sort-Object LocalPort | Format-Table -AutoSize
  } else {
    Write-Host '  nothing listening (expected when the dev server is stopped)'
  }

  try {
    $r = Invoke-WebRequest 'http://localhost:3050/' -UseBasicParsing -TimeoutSec 10
    Write-Host "  GET http://localhost:3050/ -> $($r.StatusCode)"
  } catch {
    Write-Host "  GET http://localhost:3050/ -> not responding (run scripts\dev-start.ps1)"
  }
}

Step 'Outline schema' {
  $env:PGPASSWORD = 'pass'
  # Use a SQL file: PowerShell strips double quotes when passing -c to native
  # commands, which breaks identifiers like "SequelizeMeta".
  $sql = Join-Path ([System.IO.Path]::GetTempPath()) 'outline-dev-check.sql'
  @'
SELECT 'tables=' || count(*) FROM pg_tables WHERE schemaname = 'public';
SELECT 'migrations=' || count(*) FROM "SequelizeMeta";
SELECT 'extensions=' || string_agg(extname, ', ' ORDER BY extname)
  FROM pg_extension
 WHERE extname IN ('uuid-ossp','unaccent','pg_trgm','btree_gin');
'@ | Set-Content -Path $sql -Encoding UTF8

  & $psql -U user -h 127.0.0.1 -d outline -w -t -f $sql
  Remove-Item Env:\PGPASSWORD
  Remove-Item $sql -ErrorAction SilentlyContinue
}

Step 'Environment files (must be gitignored)' {
  Set-Location (Split-Path -Parent $PSScriptRoot)
  git check-ignore -v .env .env.local
}