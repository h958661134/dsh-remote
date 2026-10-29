# dsh-remote — health check / auto repair
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1        # check only
#   powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1 -Fix   # repair what it can

param([switch]$Fix)

. "$PSScriptRoot\common.ps1"

$checks = New-Object System.Collections.ArrayList
function Pass($message) { Write-Host "  [OK]   $message" -ForegroundColor Green }
function Fail($message) { Write-Host "  [FAIL] $message" -ForegroundColor Red; [void]$checks.Add($message) }
function Warn($message) { Write-Host "  [WARN] $message" -ForegroundColor Yellow }

Write-Host ''
Write-Host '=== 1. 网关进程与端口 ===' -ForegroundColor Cyan
$processes = @(Get-GatewayProcesses)
if ($processes.Count -gt 0) { Pass "网关进程运行中 (pid $($processes.ProcessId -join ','))" }
else { Fail '网关进程未运行' }
if (Test-GatewayListening) { Pass '127.0.0.1:8787 监听中' } else { Fail '8787 未监听' }

Write-Host ''
Write-Host '=== 2. 网关自检 ===' -ForegroundColor Cyan
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/__health' -TimeoutSec 6
  if ($health.ok) { Pass "harness 在线（端口 $($health.harnessPort)）" }
  else { Fail '网关在线但 harness 未运行（桌面版没开？）' }
} catch { Fail "/__health 失败：$($_.Exception.Message)" }

Write-Host ''
Write-Host '=== 3. 启动令牌 state 文件 ===' -ForegroundColor Cyan
if (Test-Path $StateFile) {
  $state = Get-Content $StateFile -Raw | ConvertFrom-Json
  if ($state.error) { Fail "state 文件含错误：$($state.error)" }
  else { Pass "state 正常（端口 $($state.port)，导出于 $($state.exportedAt)）" }
} else { Fail 'state 文件不存在（插件未加载？）' }

Write-Host ''
Write-Host '=== 4. Harness desktop profile 插件 ===' -ForegroundColor Cyan
if (Test-Path (Join-Path $ProfileDir 'remote-gw.js')) { Pass '插件文件存在' } else { Fail '插件文件缺失' }
if (Test-Path $PatchFile) {
  if ((Get-Content $PatchFile -Raw) -match 'id:\s*remote-gw') { Pass 'cordis.patch.yml 含 remote-gw 行' }
  else { Fail 'cordis.patch.yml 缺少 remote-gw 行' }
} else { Fail 'cordis.patch.yml 不存在' }

Write-Host ''
Write-Host '=== 5. 配置与自启 ===' -ForegroundColor Cyan
if (Test-Path $ConfigFile) { Pass 'gateway/config.json 存在' } else { Fail 'gateway/config.json 不存在（运行 admin.mjs init）' }
if (Test-Path (Join-Path $StartupDir 'dsh-remote-gateway.vbs')) { Pass '开机自启已注册' } else { Warn '开机自启未注册' }

Write-Host ''
Write-Host '=== 6. Tailscale（可选，可能不可用） ===' -ForegroundColor Cyan
$tailscale = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $tailscale) {
  $candidate = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (Test-Path $candidate) { $tailscale = $candidate }
}
if ($tailscale) {
  $status = & $tailscale status --json 2>$null | ConvertFrom-Json
  if ($status -and $status.BackendState -eq 'Running') { Pass "Tailscale 已连接（$($status.Self.DNSName.TrimEnd('.'))）" }
  else { Warn 'Tailscale 未登录/未连接' }
  $serve = (& $tailscale serve status 2>&1) -join "`n"
  if ($serve -match 'proxy http://127\.0\.0\.1:8787') { Warn 'Serve 已发布：Tailscale 若走 DERP 中继会导致手机加载失败' } else { Warn 'Serve 未发布（该通道不推荐，优先用 Cloudflare 隧道）' }
} else { Warn '未安装 Tailscale' }

Write-Host ''
if ($checks.Count -eq 0) { Write-Host '全部正常 ✅' -ForegroundColor Green; exit 0 }
Write-Host "发现 $($checks.Count) 个问题" -ForegroundColor Yellow
if (-not $Fix) {
  Write-Host '加 -Fix 可自动修复：powershell -File .\scripts\doctor.ps1 -Fix' -ForegroundColor Gray
  exit 1
}

Write-Host ''
Write-Host '=== 自动修复 ===' -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $ProfileDir 'remote-gw.js'))) {
  Copy-Item (Join-Path $PluginDir 'remote-gw.js') (Join-Path $ProfileDir 'remote-gw.js') -Force
  Write-Host '  已恢复插件文件'
}
if (-not ((Get-Content $PatchFile -Raw) -match 'id:\s*remote-gw')) {
  $block = @'

# dsh-remote: export the launch token so the gateway can authenticate for a phone.
- insert:
    - id: remote-gw
      name: ./remote-gw.js
'@
  Add-Content -Path $PatchFile -Value $block -Encoding UTF8
  Write-Host '  已重新插入插件行（热加载或重启 App 后生效）'
}
if (-not (Test-Path (Join-Path $StartupDir 'dsh-remote-gateway.vbs'))) {
  Copy-Item (Join-Path $PSScriptRoot 'start-gateway.vbs') (Join-Path $StartupDir 'dsh-remote-gateway.vbs') -Force
  Write-Host '  已恢复开机自启'
}
if (-not (Test-Path $ConfigFile)) {
  & $Node (Join-Path $GatewayDir 'admin.mjs') init | Write-Host
  Write-Host '  已生成 config.json（口令见上面的输出）'
}
if (-not (Test-GatewayListening)) {
  Start-GatewayHidden
  Start-Sleep -Seconds 3
  Write-Host '  已重启网关'
}

Write-Host ''
Write-Host '修复完成，重新检查：' -ForegroundColor Green
& powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
