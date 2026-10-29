# dsh-remote — open the control panel as a desktop window (no Electron needed)
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\open-app.ps1
#
# Starts the gateway if it is not running, then opens the control panel in
# Edge/Chrome app mode: a chromeless window that behaves like a desktop app.
# Falls back to the default browser when neither is installed.

. "$PSScriptRoot\common.ps1"

$port = 8787
if (Test-Path $ConfigFile) {
  try { $port = [int](Get-Content $ConfigFile -Raw | ConvertFrom-Json).listenPort } catch {}
}
$panel = "http://127.0.0.1:$port/__ui/"

if (-not (Test-GatewayListening -Port $port)) {
  Write-Step '启动网关…'
  Start-GatewayHidden
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-GatewayListening -Port $port) { break }
  }
  if (-not (Test-GatewayListening -Port $port)) {
    Write-Err "网关没起来，先运行 scripts\doctor.ps1 看看原因"
    exit 1
  }
}

$browsers = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path $_) }

if ($browsers.Count -gt 0) {
  $profileDir = Join-Path $env:LOCALAPPDATA 'dsh-remote\app-window'
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  Start-Process -FilePath $browsers[0] -ArgumentList @(
    "--app=$panel",
    '--window-size=1180,880',
    "--user-data-dir=$profileDir"
  )
  Write-Ok "已用 $([System.IO.Path]::GetFileName($browsers[0])) 应用模式打开：$panel"
} else {
  Start-Process $panel
  Write-Ok "已用默认浏览器打开：$panel"
}
