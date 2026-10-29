# dsh-remote — uninstall / roll back
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
#
# Stops the gateway (and any tunnel), removes autostart, resets Tailscale Serve,
# and removes the remote-gw plugin row from the Harness desktop profile.
# Restart the DeepSeek Harness desktop app once afterwards so the plugin stops
# exporting the launch token.

. "$PSScriptRoot\common.ps1"

Write-Step '停止网关'
Get-GatewayProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Step '停止隧道'
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match '127\.0\.0\.1:8787' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Step '移除开机自启'
Remove-Item (Join-Path $StartupDir 'dsh-remote-gateway.vbs') -Force -ErrorAction SilentlyContinue

Write-Step '复位 Tailscale Serve'
$tailscale = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $tailscale) {
  $candidate = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (Test-Path $candidate) { $tailscale = $candidate }
}
if ($tailscale) { & $tailscale serve reset 2>$null | Out-Null }

Write-Step '移除 Harness 插件行'
if (Test-Path $PatchBackup) {
  Copy-Item $PatchBackup $PatchFile -Force
  Write-Ok '已从备份恢复 cordis.patch.yml'
} elseif (Test-Path $PatchFile) {
  $text = Get-Content $PatchFile -Raw
  $text = $text -replace '(?s)\r?\n# dsh-remote:.*?name: \./remote-gw\.js\r?\n', "`n"
  Set-Content -Path $PatchFile -Value $text -Encoding UTF8
  Write-Ok '已按标记删除插件行'
}
Remove-Item (Join-Path $ProfileDir 'remote-gw.js') -Force -ErrorAction SilentlyContinue
Remove-Item $StateFile -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '完成。网关已停止、自启已移除、插件行已清理。' -ForegroundColor Green
Write-Host '重启一次 DeepSeek Harness 桌面版，插件即不再加载。' -ForegroundColor Gray
Write-Host '（gateway/config.json 与日志保留，如需彻底删除可直接删掉仓库目录）' -ForegroundColor Gray
