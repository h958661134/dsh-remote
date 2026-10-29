# 通道部署

网关只监听 `127.0.0.1:8787`，任何能把外部流量送到这个端口、并转发到 `http://127.0.0.1:8787` 的
隧道或反向代理都可以。选一种即可，手机访问的地址就是该隧道/代理的地址。

> 通用要求：**TLS 由隧道/代理终止**；网关不需要知道你外部的 Host（它会把 Host 改写回 loopback）。
> 如果外部是 HTTPS，把 `gateway/config.json` 的 `publicUrl` 设成 `https://...`，会话 Cookie 会带 `Secure`。

---

## 1. Tailscale（⚠️ 不推荐：可能走 DERP 中继）

> **为什么不推荐**：Tailscale 只有在两端能 NAT 打洞直连时才快。打洞失败时会退回 **DERP 中继**
> （常见是 300–500ms 延迟、吞吐很低），而 Harness 前端约 1.7MB，基本传不完 —— 手机上表现为
> **白屏 / 一直卡在 Loading plugins**。控制面板已不提供该通道；本项目优先推荐第 2/3/4 节的公网隧道或 VPS。
>
> 自检：`tailscale ping <手机IP>`，若输出 `via DERP(...)` 就是中继，不要用这条路。
> 直连可用（`via 192.168.x.x` / `via 100.x.x.x`）时它依然是最私密的选择。

适合“只有我自己的设备能连”。

```powershell
# 1) 安装并登录 Tailscale（Windows 需要管理员；手机装 App 登录同一账号）
#    https://tailscale.com/download

# 2) 把网关发布到 tailnet（HTTP 80，无需证书配置）
powershell -ExecutionPolicy Bypass -File .\scripts\enable-tailscale.ps1

# 3) 手机（Tailscale 已连接）打开脚本打印的地址，例如：
#    http://laptop-xxxx.tailnet-xxxx.ts.net/
```

手动等价命令：

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" serve --bg --http=80 8787
& "C:\Program Files\Tailscale\tailscale.exe" serve status
```

要点：

- 只有登录同一 tailnet 的设备能访问，公网扫不到；
- 手机与电脑在同一 Wi-Fi 时通常是**直连**，速度很好；
- 异地时若无法打洞，会走 DERP 中继（几百毫秒 + 低吞吐），1.7MB 前端可能加载不完
  （症状：卡在 `Loading plugins`）。检查：`tailscale ping <手机IP>` 是否显示 `via DERP(...)`。
  遇到这种情况改用下面的公网隧道，或给 Tailscale 配一个近地 DERP。

---

## 2. Cloudflare 快速隧道（零账号，地址每次变）

适合“马上要能用”。

```powershell
# 下载 cloudflared（Windows amd64）
curl.exe -L -o bin\cloudflared.exe `
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe

# 启动隧道，日志里会出现 https://xxx.trycloudflare.com
powershell -ExecutionPolicy Bypass -File .\scripts\refresh-tunnel.ps1
```

`refresh-tunnel.ps1` 会：重启隧道 → 抓取新地址 → 写回 `publicUrl` → 重启网关 →
重新生成桌面访问页和二维码 → 输出地址。

> 重启电脑或隧道后地址会变，需要再跑一次（可放进启动文件夹，见脚本头部说明）。

---

## 3. Cloudflare 命名隧道（固定域名，推荐长期）

需要**一个域名**（托管在 Cloudflare，免费套餐即可）。

```powershell
# 1) 一次性登录
cloudflared tunnel login

# 2) 建隧道并解析域名（假设隧道名 dsh，域名 example.com）
cloudflared tunnel create dsh
cloudflared tunnel route dns dsh dsh.example.com

# 3) 配置文件 %USERPROFILE%\.cloudflared\config.yml
```

```yaml
tunnel: dsh
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```powershell
# 4) 运行
cloudflared tunnel run dsh
# 5) 注册为开机服务（管理员）
cloudflared service install
```

然后把 `gateway/config.json` 的 `publicUrl` 设为 `https://dsh.example.com`，重启网关：

```powershell
node gateway\admin.mjs show          # 确认当前配置
# 修改 publicUrl 后重启：结束 node 进程，再运行 scripts\start-gateway.vbs 等效的启动命令
```

可选：在 Cloudflare Zero Trust 里给该域名加 **Access**（邮箱/OTP 验证），这样连口令都可以省。

---

## 4. ngrok（固定免费域名）

需要注册 ngrok 账号，免费计划提供 1 个静态域名。

```powershell
ngrok config add-authtoken <你的 token>
ngrok http --url=your-name.ngrok-free.app 8787
# 或使用你账号下的静态域名：ngrok http 8787
```

把 `publicUrl` 设为 `https://your-name.ngrok-free.app` 后重启网关。

---

## 5. 自建 VPS（frp / nginx / Caddy）

最快最稳，且可以只对自己的 IP 开放。

**方案 A：nginx / Caddy 反代 + HTTPS**

```nginx
# nginx
server {
  listen 443 ssl http2;
  server_name dsh.example.com;
  ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket 必须
    proxy_set_header Connection "upgrade";       # WebSocket 必须
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;                    # 会话流是长连接
    proxy_buffering off;
  }
}
```

```caddyfile
# Caddy（自动证书）
dsh.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

若 VPS 与电脑不在同一台机器，用 **frp** 把电脑的 8787 暴露到 VPS 的回环地址：

```ini
# frps（VPS）
[common]
bind_port = 7000

# frpc（电脑）
[common]
server_addr = your-vps-ip
server_port = 7000

[dsh]
type = tcp
local_ip = 127.0.0.1
local_port = 8787
remote_port = 8787
```

然后 VPS 上按上面的 nginx/Caddy 反代 `127.0.0.1:8787`。

**方案 B：只对自己 IP 开放**（配合 nginx `allow/deny` 或云防火墙），安全性最高。

---

## 6. 其他任意反代

只要满足：

1. 转发到 `http://127.0.0.1:8787`；
2. 支持 **WebSocket upgrade**（`/api/remote.mux`）；
3. 关闭响应缓冲（SSE/流式响应）；
4. 足够长的读超时（会话流是长连接）；
5. HTTPS 时把 `publicUrl` 写成 `https://...`。

不需要 Special 的 Host 处理 —— 网关自己会把 Host 改写回 loopback。
