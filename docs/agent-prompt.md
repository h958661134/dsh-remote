# One-click agent prompt / 一键部署 Prompt

把下面整段复制给你的 AI Agent（DeepSeek Harness 本身、Claude Code、Codex CLI、Cursor 等都能用）。
Agent 会完成：装插件 → 生成配置 → 起网关 → 打通一条非局域网通道 → 生成手机入口 → 12 项自检 → 汇报地址与口令。

> 前提：DeepSeek Harness **桌面版已安装并至少启动过一次**；电脑上有 Node.js ≥ 18；
> 手机与电脑不在同一局域网也可以（这正是本项目的目标）。

---

## 中文 Prompt（复制这段）

```text
你是正在用户电脑上工作的 AI Agent。请部署 dsh-remote，让用户的手机在任意网络下访问
正在运行的 DeepSeek Harness 桌面版。请严格按步骤执行，任何一步失败就停下并报告。

【背景，已确认，不要试图改动 Harness】
- 桌面版只监听 127.0.0.1，端口随机；鉴权依赖每进程随机生成的 launch token + 签名 Cookie。
- 本项目由两部分组成：
  1) plugin/remote-gw.js —— 桌面 profile 插件，被 profile loader 热加载（通常无需重启 App），
     把 { port, launchUrl(带启动令牌) } 写入 profile 目录下的 remote-gw-state.json；
  2) gateway/server.mjs —— 零依赖网关：口令登录后用 launch token 换 Harness Cookie，
     再把 HTTP/WebSocket 反代到 127.0.0.1:<port>，同时把 Host/Origin 改写回 loopback。
- 手机端只需要一个普通浏览器，不需要局域网。

【第 0 步：定位与检查】
- 若尚未拿到仓库：git clone https://github.com/h958661134/dsh-remote.git 并 cd 进去。
- 检查 node -v（需要 >= 18）。
- 定位 DSH profile 目录：
  Windows: %USERPROFILE%\.dsh\profiles\desktop
  Linux/macOS: $DSH_HOME/profiles/desktop（默认 ~/.dsh/profiles/desktop）
  目录不存在：停止，让用户先安装并启动一次桌面版 Harness。

【第 1 步：安装插件】
- 备份 cordis.patch.yml 为 cordis.patch.yml.bak-before-remote（若备份已存在则跳过）。
- 复制 plugin/remote-gw.js 到 profile 目录。
- 若 cordis.patch.yml 中没有 id: remote-gw，则追加：
    # dsh-remote: export the launch token so the gateway can authenticate for a phone.
    - insert:
        - id: remote-gw
          name: ./remote-gw.js
- 等待最多 10 秒，确认 profile 目录出现 remote-gw-state.json。
  仍未出现：请用户重启一次桌面版 Harness，然后再确认。

【第 2 步：生成网关配置】
- 若 gateway/config.json 不存在：运行 node gateway/admin.mjs init。
- 从输出中取出随机口令，写入 gateway/access.txt（不要发到公开渠道）。
- 若 config.json 已存在则保留其口令（可用 node gateway/admin.mjs show 查看配置）。

【第 3 步：启动网关并验证本机链路】
- 后台启动 node gateway/server.mjs，日志写入 gateway/gateway.log。
- 访问 http://127.0.0.1:8787/__health，必须返回 "ok": true。
- 运行：node gateway/selftest.mjs <口令> http://127.0.0.1:8787 ，必须 12/12 通过。

【第 4 步：开通一条“非局域网”通道】
默认用 A，除非用户明确要求私有网络：
A. 公网（默认，无需账号，地址每次重启变化）：
   - 下载 cloudflared 到 bin/（Windows 二进制或对应平台版本），
   - Windows: powershell -ExecutionPolicy Bypass -File .\scripts\refresh-tunnel.ps1
   - 或手动：cloudflared tunnel --url http://127.0.0.1:8787
   手机地址形如 https://<随机>.trycloudflare.com
- 发布成功后，把地址写入 gateway/tunnel-url.txt；HTTPS 时把 gateway/config.json 的
  publicUrl 设为该地址并重启网关（让会话 Cookie 带 Secure）。

B. （可选，仅在用户明确要求时）Tailscale —— **先警告**：两端无法打洞时会走 DERP 中继
   （300–500ms、低吞吐），1.7MB 前端可能加载不完，手机白屏/卡 Loading plugins。
   验证：tailscale ping <手机IP> 显示 via DERP(...) 就不要用。

【第 5 步：生成手机入口】
- 如系统有 python3 且能 pip install qrcode pillow：
  python scripts/make-page.py - <桌面路径>/手机访问.html <地址>
  python scripts/make-qr.py gateway/phone-qr.png
- 没有 python 就跳过，只在汇报里给出地址与口令。

【第 6 步：再次端到端验证】
- node gateway/selftest.mjs <口令> <第 4 步得到的地址>
- 必须 12/12 通过（包含 “proxied POST /api/session/list reaches harness”）。

【第 7 步：汇报给用户】
请给出：
1) 手机访问地址（https 公网隧道地址）
2) 访问口令
3) 使用的通道类型（Cloudflare 快速隧道 / 其他）
4) 是否已配置开机自启（scripts/install.ps1 会装；也可手动把 scripts/start-gateway.vbs
   复制到启动文件夹）
5) 回滚方式：powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1

【硬性约束】
- 不要修改 Harness 源码或 app.asar；除第 1 步外不要重启桌面 App。
- 不要改 gateway/config.json 的 listenHost 为 0.0.0.0；监听保持 127.0.0.1。
- 不要把 launch token、dsh-auth Cookie 或口令贴到公开日志/仓库；access.txt 仅本机保存。
- 任何一步失败：保留现场，报告执行过的命令、错误输出、gateway/gateway.log 最后 30 行。
- 若用户手机是安卓且同时开着 Clash：提醒 Tailscale 与 Clash 互斥（同一时间只能一个 VPN），
  公网隧道方案则不受影响。
```

---

## English prompt (copy this)

```text
You are an AI agent working on the user's computer. Deploy dsh-remote so the user's phone can
reach the running DeepSeek Harness desktop app from any network. Follow the steps exactly and
stop on the first failure.

Context (already established — do not modify the harness):
- The desktop app binds 127.0.0.1 on a random port and authenticates with a per-process launch
  token plus a signed cookie.
- This repo has two parts:
  1) plugin/remote-gw.js — a desktop-profile plugin hot-mounted by the profile loader. It writes
     { port, launchUrl } (with the launch token) to remote-gw-state.json in the profile directory.
  2) gateway/server.mjs — a zero-dependency gateway: password login, launch-token -> harness
     cookie exchange, HTTP + WebSocket reverse proxy to 127.0.0.1:<port> with Host/Origin
     rewritten to loopback.

Step 0 — locate and check
- Clone https://github.com/h958661134/dsh-remote.git if needed and cd into it.
- node -v must be >= 18.
- Profile dir: Windows %USERPROFILE%\.dsh\profiles\desktop; Linux/macOS
  ${DSH_HOME:-~/.dsh}/profiles/desktop. If missing, ask the user to install and start the
  desktop app once, then stop.

Step 1 — install the plugin
- Back up cordis.patch.yml to cordis.patch.yml.bak-before-remote (skip if it exists).
- Copy plugin/remote-gw.js into the profile dir.
- If the patch has no `id: remote-gw`, append:

    - insert:
        - id: remote-gw
          name: ./remote-gw.js

- Wait up to 10s for remote-gw-state.json. If absent, ask the user to restart the desktop app once.

Step 2 — gateway config
- If gateway/config.json is missing, run: node gateway/admin.mjs init
- Keep the printed random password in gateway/access.txt (local only). Reuse an existing config
  otherwise.

Step 3 — start and verify locally
- Start `node gateway/server.mjs` in the background (log to gateway/gateway.log).
- GET http://127.0.0.1:8787/__health must return "ok": true.
- node gateway/selftest.mjs <password> http://127.0.0.1:8787 must pass 12/12.

Step 4 — open one non-LAN transport (default to the public tunnel)
A. Public (default, no account, URL changes on restart): cloudflared quick tunnel
   Windows: powershell -ExecutionPolicy Bypass -File .\scripts\refresh-tunnel.ps1
   or: cloudflared tunnel --url http://127.0.0.1:8787
- Write the resulting address to gateway/tunnel-url.txt; for HTTPS set publicUrl in
  gateway/config.json and restart the gateway so cookies get the Secure flag.

B. (optional, only if the user explicitly asks for a private network) Tailscale — warn first:
   when both peers cannot punch through, traffic is relayed via DERP (300-500ms, low
   throughput) and the ~1.7MB frontend may never load (blank screen / stuck on
   "Loading plugins"). Check with `tailscale ping <phone-ip>`; `via DERP(...)` means do not use it.

Step 5 — phone entry page
- If python3 with qrcode+pillow is available:
  python scripts/make-page.py - <Desktop>/phone-access.html <url>; python scripts/make-qr.py
- Otherwise skip and report the URL and password only.

Step 6 — verify end to end
- node gateway/selftest.mjs <password> <url> must pass 12/12, including the
  "proxied POST /api/session/list reaches harness" check.

Step 7 — report
- phone URL, access password, transport used (public tunnel by default), autostart status, rollback command
  (powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1).

Hard constraints
- Do not modify the harness source or app.asar; do not restart the desktop app except step 1.
- Keep listenHost at 127.0.0.1 (never 0.0.0.0).
- Never print the launch token or the harness dsh-auth cookie; keep access.txt local.
- On failure keep the state, report commands run, the error and the last 30 lines of gateway.log.
- On Android, Tailscale and Clash cannot run at the same time (one VPN slot); tunnels are fine.
```

---

## Agent 应该交付什么

- 一条手机可打开的地址（`https://...` 或 `http://<tailnet>`）
- 访问口令
- `selftest.mjs` 的 12/12 输出
- 回滚命令与日志路径

## 常见偏差（供 Agent 自查）

| 偏差 | 处理 |
|---|---|
| 插件没热加载 | 让用户重启一次桌面 App，再等 state 文件 |
| 手机白屏 / 卡 Loading plugins | 通道太慢（Tailscale 走了 DERP 中继）→ 换公网隧道 |
| 页面能开但会话为空 | 网关版本旧（POST body 未转发）→ 用本仓库最新代码 |
| 401 反复出现 | 口令错误或 Cookie 过期；`admin.mjs set-password` 重置 |
| 隧道地址过期 | 重跑 `refresh-tunnel.ps1` |
