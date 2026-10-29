# dsh-remote — one-click installer (Windows)
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Password "your-password" -NoAutostart
#
# What it does:
#   1. verifies Node.js and the DeepSeek Harness desktop profile
#   2. installs the remote-gw plugin into the profile (backing up cordis.patch.yml)
#   3. creates gateway/config.json with a random (or given) access password
#   4. starts the gateway on 127.0.0.1:8787
#   5. renders the phone access page + QR code on the Desktop (needs python + qrcode)
#   6. registers autostart (unless -NoAutostart)

param(
  [string]$Password,
  [switch]$NoAutostart
)

. "$PSScriptRoot\common.ps1"

Write-Step '检查 Node.js'
if (-not $NodeOk) {
  Write-Err "未找到 Node.js（需要 >= 18）。安装：https://nodejs.org/"
  exit 1
}
Write-Ok "$(& $Node --version) @ $Node"

Write-Step '检查 DeepSeek Harness desktop profile'
if (-not (Test-Path $ProfileDir)) {
  Write-Err "未找到 $ProfileDir"
  Write-Warn '请先安装并至少启动一次 DeepSeek Harness 桌面版。'
  exit 1
}
Write-Ok $ProfileDir

Write-Step '安装 remote-gw 插件'
Copy-Item (Join-Path $PluginDir 'remote-gw.js') (Join-Path $ProfileDir 'remote-gw.js') -Force
if (-not (Test-Path $PatchBackup) -and (Test-Path $PatchFile)) {
  Copy-Item $PatchFile $PatchBackup -Force
  Write-Ok "已备份 cordis.patch.yml"
}
if (-not (Test-Path $PatchFile)) {
  Set-Content -Path $PatchFile -Value "[]`n" -Encoding UTF8
}
if ((Get-Content $PatchFile -Raw) -match 'id:\s*remote-gw') {
  Write-Ok '插件行已存在'
} else {
  $block = @'

# dsh-remote: export the launch token so the gateway can authenticate for a phone.
- insert:
    - id: remote-gw
      name: ./remote-gw.js
'@
  Add-Content -Path $PatchFile -Value $block -Encoding UTF8
  Write-Ok '已插入插件行（profile loader 会热加载）'
}

Write-Step '初始化网关配置'
if (Test-Path $ConfigFile) {
  Write-Ok 'config.json 已存在，保留现有口令'
} else {
  if ($Password) {
    & $Node (Join-Path $GatewayDir 'admin.mjs') init | Out-Null
    & $Node (Join-Path $GatewayDir 'admin.mjs') set-password $Password | Out-Null
  } else {
    $output = & $Node (Join-Path $GatewayDir 'admin.mjs') init 2>&1 | Out-String
    Write-Host $output.Trim()
    $match = [regex]::Match($output, 'access password:\s*(\S+)')
    if ($match.Success) { $Password = $match.Groups[1].Value }
  }
  if ($Password) {
    [System.IO.File]::WriteAllText(
      (Join-Path $GatewayDir 'access.txt'),
      "password: $Password`ngenerated: $((Get-Date).ToString('o'))`n",
      (New-Object System.Text.UTF8Encoding($false))
    )
  }
}

Write-Step '启动网关'
if (Test-GatewayListening) {
  Write-Ok '网关已在运行（127.0.0.1:8787）'
} else {
  Start-GatewayHidden
  Start-Sleep -Seconds 3
  if (Test-GatewayListening) { Write-Ok '已启动 127.0.0.1:8787' }
  else { Write-Err '启动失败，请运行 scripts\doctor.ps1 查看原因' }
}

Write-Step '生成手机访问页与二维码'
$python = Find-Python
if ($python) {
  $env:PYTHONPATH = Join-Path $GatewayDir 'pylib'
  & $python -c 'import qrcode, PIL' 2>$null
  if ($LASTEXITCODE -eq 0) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    & $python (Join-Path $PSScriptRoot 'make-page.py') '-' (Join-Path $desktop '手机访问.html') 2>$null | Out-Null
    & $python (Join-Path $PSScriptRoot 'make-qr.py') (Join-Path $GatewayDir 'phone-qr.png') 2>$null | Out-Null
    Write-Ok '桌面已生成「手机访问.html」'
  } else {
    Write-Warn '缺少 python 包 qrcode/pillow，跳过访问页（pip install qrcode pillow）'
  }
} else {
  Write-Warn '未找到 python，跳过访问页（不影响使用）'
}

Write-Step '安装开机自启'
if ($NoAutostart) {
  Write-Warn '已跳过（-NoAutostart）'
} else {
  Copy-Item (Join-Path $PSScriptRoot 'start-gateway.vbs') (Join-Path $StartupDir 'dsh-remote-gateway.vbs') -Force
  Write-Ok "已注册：$StartupDir\dsh-remote-gateway.vbs"
}

$password = Get-AccessPassword
Write-Host ''
Write-Host '========================================' -ForegroundColor Green
Write-Host ' dsh-remote 安装完成' -ForegroundColor Green
Write-Host " 网关：    http://127.0.0.1:8787"
if ($password) { Write-Host " 访问口令：$password" }
Write-Host '========================================' -ForegroundColor Green
Write-Host ''
Write-Host '下一步：选一条“不在局域网也能连”的通道' -ForegroundColor Cyan
Write-Host '  Tailscale（私有）:   powershell -File .\scripts\enable-tailscale.ps1'
Write-Host '  Cloudflare（公网）:  powershell -File .\scripts\refresh-tunnel.ps1'
Write-Host '  体检/修复:           powershell -File .\scripts\doctor.ps1 [-Fix]'
Write-Host ''
