# 排错

先跑一次体检，大部分问题能直接定位：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1        # 只检查
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1 -Fix   # 自动修复
```

网关日志：`gateway\gateway.log`；隧道日志：`gateway\tunnel.err.log`。

---

## 手机端现象

### 白屏 / 一直转圈

1. 看日志里有没有 `CLIENT-REPORT ... "kind":"error"`。
2. 若报 `Promise.withResolvers is not a function` → 浏览器内核 < 119。新版网关会注入兼容层，
   确认 `clientSupport` 为 `true`，并**强制刷新**（HTML 响应已是 `no-store`）。
3. 若没有任何报错、`diag` 显示 `scripts` 里有 `/assets/index-*.js` 但资源列表里没有它 →
   **大文件传不完，多半是通道太慢**（典型：Tailscale 走了 DERP 中继）。换通道。

### 卡在 “Loading plugins”

同上，通常是 `diag` 里能看到模块加载队列 `pendingQueue` 非 0、且大 bundle 未完成。检查通道延迟：

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" ping <手机IP>     # 看是否 via DERP
```

### 页面能开，但会话 / 任务 / 对话是空的

网关没有把 **POST 请求体**转发给 Harness（旧版本 bug），表现为 `/api/*` 全部 `502` 且耗时 ~20s。
升级到当前版本即可，`selftest.mjs` 里有回归检查：

```powershell
node gateway\selftest.mjs <口令> http://127.0.0.1:8787
# 期待 12/12，包含 "proxied POST /api/session/list reaches harness"
```

### 打开显示「Harness 未运行」

- 桌面版 Harness 没启动 → 启动即可，网关会自动重新读取状态；
- 或插件没装：检查 `%USERPROFILE%\.dsh\profiles\desktop\remote-gw-state.json` 是否存在；
- 插件行被设置页覆盖：`doctor.ps1 -Fix` 会重新插入。

### 反复跳登录页 / 401

- 口令错误（10 次会锁 IP 10 分钟）；
- 会话 Cookie 过期（默认 30 天）或被清除；
- 更换过 `sessionSecret`（旧的全部失效）。

### 手机打不开地址

- Tailscale 没打开（安卓上 Clash 与 Tailscale 互斥，只能二选一）；
- 隧道没起：`gateway\tunnel.err.log` 看 cloudflared 是否注册成功；
- 快速隧道地址变了：重跑 `scripts\refresh-tunnel.ps1`。

---

## 电脑端排查

```powershell
# 网关是否在跑、端口是否监听
Get-NetTCPConnection -LocalPort 8787 -State Listen

# 状态文件（令牌不要外发）
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\remote-gw-state.json"

# 网关自检（不经过隧道，最少变量）
node gateway\selftest.mjs <口令> http://127.0.0.1:8787

# 插件是否在 profile 里
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Pattern remote-gw

# 用无头浏览器看手机上会看到什么（可模拟旧内核）
node gateway\probe-browser.mjs http://127.0.0.1:8787 --wait 8000
node gateway\probe-browser.mjs http://127.0.0.1:8787 --emulate-old
```

`probe-browser.mjs` 会输出：渲染文本、`isSecureContext`、兼容层版本、控制台错误、失败请求。

---

## 真实踩过的坑（案例）

| 症状 | 根因 | 修复 |
|---|---|---|
| `401 dsh web authentication required` | 直接访问 Harness 端口，没有启动令牌 | 网关换 Cookie 后访问 |
| 手机白屏、`Promise.withResolvers is not a function` | OPPO 自带浏览器 Chromium 115 | 注入兼容层 |
| 手机一直 Loading plugins、无 JS 报错 | Tailscale 中继 400ms，1.7MB 前端传不完 | 改用 Cloudflare/ngrok/VPS 通道 |
| 界面能开但会话全空、`/api/*` 全 502 20s | 网关转发 POST 时丢了 body | 缓冲请求体后再转发，并加重试 |
| 桌面页二维码过期 | 快速隧道地址变化 | 重跑 `refresh-tunnel.ps1` |
