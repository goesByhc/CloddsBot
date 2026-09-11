# Start the order-book observer as a detached process.
#
# WHY DETACHED
# ------------
# Observing the book at 5s resolution for days is the whole point of phase 1, but a
# process launched as a child of an agent/tool session dies with that session. This
# wrapper starts it with Start-Process so it owns its own lifetime and keeps writing
# after the launching shell exits.
#
# It also refuses to start a second copy: two observers writing one file triples
# every record (same slug+side+ts), which is silent and would corrupt the dataset.
#
#   pwsh -File scripts/start-observer.ps1
#   pwsh -File scripts/start-observer.ps1 -IntervalMs 5000 -Assets "btc,eth,sol"
#   pwsh -File scripts/start-observer.ps1 -Stop

param(
  [string]$Assets = "btc,eth,sol",
  [string]$Duration = "15m",
  [int]$IntervalMs = 5000,
  [string]$OutDir = "",
  [switch]$Stop,
  [switch]$Status
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $repo ".cache\orderbook" }

function Get-Observers {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'observe-orderbook' }
}

if ($Status -or $Stop) {
  $obs = @(Get-Observers)
  if ($obs.Count -eq 0) {
    Write-Host "no observer running"
    if ($Stop) { exit 0 }
  } else {
    foreach ($o in $obs) {
      $mins = [math]::Round(((Get-Date) - $o.CreationDate).TotalMinutes, 1)
      Write-Host "  PID $($o.ProcessId)  running $mins min"
    }
  }
  if ($Stop) {
    foreach ($o in $obs) {
      try { Stop-Process -Id $o.ProcessId -Force -ErrorAction Stop; Write-Host "  stopped $($o.ProcessId)" }
      catch { Write-Host "  could not stop $($o.ProcessId): $($_.Exception.Message)" }
    }
    # tsx spawns a child; sweep any stragglers referencing the script.
    Start-Sleep -Seconds 2
    $left = @(Get-Observers)
    if ($left.Count -gt 0) {
      foreach ($o in $left) { try { Stop-Process -Id $o.ProcessId -Force } catch {} }
      Write-Host "  swept $($left.Count) remaining"
    }
    exit 0
  }
  if ($Status) { exit 0 }
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

# Refuse to run twice: duplicate records would be silent.
$existing = @(Get-Observers)
if ($existing.Count -gt 0) {
  Write-Host "REFUSING to start: $($existing.Count) observer process(es) already running."
  Write-Host "Two observers writing one file duplicates every record (same slug+side+ts)."
  Write-Host "Stop them first:  pwsh -File scripts/start-observer.ps1 -Stop"
  exit 1
}

$log = Join-Path $OutDir "observer.log"
$err = Join-Path $OutDir "observer.err.log"

# Invoke node directly on tsx's CLI entry.
#
# `Start-Process -FilePath "npx"` fails with "not a valid Win32 application": npx on
# Windows is a .cmd shim, and Start-Process does no shell resolution for CreateProcess.
# node.exe + the CLI path avoids the shim entirely and is what actually persists.
$nodeExe = (Get-Command node).Source
$tsxCli = Join-Path $repo "node_modules\tsx\dist\cli.mjs"
if (-not (Test-Path $tsxCli)) {
  Write-Host "tsx CLI not found at $tsxCli"
  exit 1
}

$argList = @(
  $tsxCli, "scripts/observe-orderbook.ts",
  "--assets", $Assets,
  "--duration", $Duration,
  "--interval-ms", "$IntervalMs",
  "--out", $OutDir
)

Write-Host "starting detached observer"
Write-Host "  assets  : $Assets"
Write-Host "  duration: $Duration"
Write-Host "  interval: ${IntervalMs}ms"
Write-Host "  out     : $OutDir"
Write-Host "  log     : $log"

$p = Start-Process -FilePath $nodeExe -ArgumentList $argList -WorkingDirectory $repo `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $log -RedirectStandardError $err

Start-Sleep -Seconds 6
$obs = @(Get-Observers)
if ($obs.Count -eq 0) {
  Write-Host "`nWARNING: no observer process detected after start."
  Write-Host "Check $err"
  exit 1
}
Write-Host "`nstarted: $($obs.Count) process(es)"
Write-Host "check progress:  node scripts/observe-status.mjs"
Write-Host "stop:            pwsh -File scripts/start-observer.ps1 -Stop"
