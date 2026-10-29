# dsh-remote — publish the gateway to your tailnet with Tailscale Serve (NOT RECOMMENDED)
#
# WARNING: Tailscale only performs well when both peers can establish a direct
# connection. When NAT traversal fails, traffic is relayed via DERP (typically
# 300-500 ms with low throughput) and the ~1.7 MB harness frontend may never
# finish loading — the phone shows a blank screen or stays on "Loading plugins".
# Check with:  tailscale ping <phone-ip>   → "via DERP(...)" means unusable.
# Prefer the Cloudflare tunnel / ngrok / your own VPS (docs/deployment.md).
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\enable-tailscale.ps1
#
# Requires Tailscale installed and logged in on this machine. Publishes
# 127.0.0.1:8787 as plain HTTP on the node's tailnet address (no certificate
# setup needed) and prints the phone URL.

. "$PSScriptRoot\common.ps1"

$tailscale = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $tailscale) {
  $candidate = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (Test-Path $candidate) { $tailscale = $candidate }
}
if (-not $tailscale) {
  Write-Err '未找到 tailscale.exe，请先安装：https://tailscale.com/download'
  exit 1
}

$status = & $tailscale status --json 2>$null | ConvertFrom-Json
if (-not $status -or $status.BackendState -ne 'Running') {
  Write-Err 'Tailscale 未登录/未连接。先执行：'
  & $tailscale status 2>&1 | Write-Host
  exit 1
}

$dnsName = ($status.Self.DNSName).TrimEnd('.')
$ip = ($status.Self.TailscaleIPs | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' } | Select-Object -First 1)
Write-Ok "Tailscale 已连接：$dnsName ($ip)"

& $tailscale serve reset 2>$null | Out-Null
$output = (& $tailscale serve --bg --http=80 8787 2>&1) -join "`n"
Write-Host $output

$url = $null
if ($output -match 'http://([^\s/]+)/?') { $url = $Matches[0].TrimEnd('/') + '/' }
if (-not $url -and $dnsName) { $url = "http://$dnsName/" }
if (-not $url) {
  Write-Err '无法解析 serve 输出，请手工执行：tailscale serve status'
  exit 1
}

& $Node -e "const fs=require('fs');const p=process.argv[1];const u=process.argv[2];const c=JSON.parse(fs.readFileSync(p,'utf8'));c.publicUrl=u.startsWith('https://')?u:'';fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');" `
  $ConfigFile $url

Get-GatewayProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 700
Start-GatewayHidden
Start-Sleep -Seconds 3

[System.IO.File]::WriteAllText((Join-Path $GatewayDir 'tunnel-url.txt'), '', (New-Object System.Text.UTF8Encoding($false)))

$python = Find-Python
if ($python) {
  $env:PYTHONPATH = Join-Path $GatewayDir 'pylib'
  & $python (Join-Path $PSScriptRoot 'make-page.py') '-' (Join-Path ([Environment]::GetFolderPath('Desktop')) '手机访问.html') $url 2>$null | Out-Null
  & $python (Join-Path $PSScriptRoot 'make-qr.py') (Join-Path $GatewayDir 'phone-qr.png') 2>$null | Out-Null
}

Write-Host ''
Write-Host '========================================' -ForegroundColor Green
Write-Host " 手机地址: $url"
Write-Host ' 前提：手机已安装 Tailscale 并登录同一账号、开关已打开'
Write-Host '========================================' -ForegroundColor Green
