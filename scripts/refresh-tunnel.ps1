# dsh-remote — (re)start the Cloudflare quick tunnel and refresh the phone entry
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\refresh-tunnel.ps1
#
# Cloudflare quick tunnels get a new random hostname on every restart, so this
# script: restarts cloudflared → captures the new https URL → writes it into
# gateway/config.json (publicUrl, for Secure cookies) → restarts the gateway →
# regenerates the Desktop page and QR code.

param([switch]$Quiet)

. "$PSScriptRoot\common.ps1"

function Say($message) { if (-not $Quiet) { Write-Host $message } }

$cloudflared = Join-Path $RepoRoot 'bin\cloudflared.exe'
if (-not (Test-Path $cloudflared)) {
  Write-Err "未找到 cloudflared：$cloudflared"
  Write-Host '下载（任选其一）：'
  Write-Host '  curl.exe -L -o bin\cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  Write-Host '  或 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
  exit 1
}

if (-not (Test-GatewayListening)) {
  Say '网关未运行，先启动…'
  Start-GatewayHidden
  Start-Sleep -Seconds 3
}

Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match '127\.0\.0\.1:8787' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

$outLog = Join-Path $GatewayDir 'tunnel.log'
$errLog = Join-Path $GatewayDir 'tunnel.err.log'
Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
Start-Process -FilePath 'wscript.exe' -ArgumentList @("`"$(Join-Path $PSScriptRoot 'start-tunnel.vbs')`"") -WindowStyle Hidden

$url = $null
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  $text = (Get-Content $outLog -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $errLog -Raw -ErrorAction SilentlyContinue)
  $match = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($match.Success) { $url = $match.Value; break }
}
if (-not $url) {
  Write-Err '没有拿到 tunnel 地址，检查 gateway\tunnel.err.log'
  Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue
  exit 1
}

# publicUrl → Secure session cookie
& $Node -e "const fs=require('fs');const p=process.argv[1];const u=process.argv[2];const c=JSON.parse(fs.readFileSync(p,'utf8'));c.publicUrl=u;fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');" `
  $ConfigFile $url

Get-GatewayProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 700
Start-GatewayHidden
Start-Sleep -Seconds 3

[System.IO.File]::WriteAllText((Join-Path $GatewayDir 'tunnel-url.txt'), "$url`n", (New-Object System.Text.UTF8Encoding($false)))

$python = Find-Python
if ($python) {
  $env:PYTHONPATH = Join-Path $GatewayDir 'pylib'
  & $python (Join-Path $PSScriptRoot 'make-page.py') '-' (Join-Path ([Environment]::GetFolderPath('Desktop')) '手机访问.html') "$url/" 2>$null | Out-Null
  & $python (Join-Path $PSScriptRoot 'make-qr.py') (Join-Path $GatewayDir 'phone-qr.png') 2>$null | Out-Null
}

$password = Get-AccessPassword
Say ''
Say '========================================'
Say (" 公网地址: " + $url)
if ($password) { Say (" 访问口令: " + $password) }
Say '========================================'
