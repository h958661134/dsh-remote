# Shared helpers for the dsh-remote Windows scripts.
# Dot-source this file: . "$PSScriptRoot\common.ps1"

$ErrorActionPreference = 'Continue'

$RepoRoot    = Split-Path -Parent $PSScriptRoot
$GatewayDir  = Join-Path $RepoRoot 'gateway'
$PluginDir   = Join-Path $RepoRoot 'plugin'
$DshHome     = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir  = Join-Path $DshHome 'profiles\desktop'
$StateFile   = Join-Path $ProfileDir 'remote-gw-state.json'
$PatchFile   = Join-Path $ProfileDir 'cordis.patch.yml'
$PatchBackup = "$PatchFile.bak-before-remote"
$ConfigFile  = Join-Path $GatewayDir 'config.json'
$StartupDir  = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
$NodeOk = $Node -and (Test-Path $Node)

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Ok($message)   { Write-Host "    [OK] $message" -ForegroundColor Green }
function Write-Warn($message) { Write-Host "    [!]  $message" -ForegroundColor Yellow }
function Write-Err($message)  { Write-Host "    [x]  $message" -ForegroundColor Red }

function Get-GatewayProcesses {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'gateway[\\/]server\.mjs' }
}

function Test-GatewayListening([int]$Port = 8787) {
  [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Start-GatewayHidden {
  $vbs = Join-Path $PSScriptRoot 'start-gateway.vbs'
  Start-Process -FilePath 'wscript.exe' -ArgumentList @("`"$vbs`"") -WindowStyle Hidden
}

function Get-AccessPassword {
  $file = Join-Path $GatewayDir 'access.txt'
  if (Test-Path $file) {
    foreach ($line in Get-Content $file) {
      if ($line -match '^\s*password:\s*(.+)$') { return $Matches[1].Trim() }
    }
  }
  return $null
}

function Find-Python {
  $candidates = @(
    (Get-Command python -ErrorAction SilentlyContinue).Source,
    (Get-Command py -ErrorAction SilentlyContinue).Source
  ) | Where-Object { $_ }
  foreach ($candidate in $candidates) { return $candidate }
  return $null
}
