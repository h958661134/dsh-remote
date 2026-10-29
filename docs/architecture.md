# 架构与工作原理

本文记录 `dsh-remote` 的调用链、关键判定和安全边界，便于二次开发和排错。

## 1. 为什么不能直接访问

DeepSeek Harness 桌面版的 Web GUI（`@deepseek-ai/dsh-host-webserver` + `dsh-client-connection`）有两个约束：

1. **只监听回环地址**：桌面宿主以 `--host 127.0.0.1 --port 0` 启动，端口每个进程随机。
2. **浏览器信任围栏 + 启动令牌鉴权**：
   - 每个进程生成一枚随机 launch token；`GET /?token=...` 才能换取签名 Cookie `dsh-auth-<authority>=v1.<payload>.<sig>`。
   - Cookie 的 audience 绑定 `host:port`（例如 `127.0.0.1:62228`）。
   - 非鉴权请求返回 401；`Host` 不在 `{loopback, 监听地址}` 且不在 `trustedHosts` 时返回 403。
   - 还存在 `/api/remote.mux` 的 WebSocket 升级，同样要过鉴权。

因此外部设备即使能连到端口，也拿不到 Cookie —— 这正是本项目要绕开的部分，但方式是**在主机内部拿到令牌**，而不是破解。

## 2. 整体链路

```
手机 ──HTTPS/WSS──> 隧道/反代 ──HTTP/WS──> 网关(127.0.0.1:8787) ──HTTP/WS──> Harness(127.0.0.1:随机端口)
                                              │  Host/Origin 改写为 127.0.0.1:<port>
                                              │  Cookie 注入 dsh-auth-*
                                              ▼
                                       插件 remote-gw 写出的 state 文件（port + launch token）
```

## 3. 插件：导出端口与令牌

`plugin/remote-gw.js` 是一个 Cordis 插件，声明 `inject: ['webServer', 'connection']`，在 `apply()` 里：

```js
const port = ctx.webServer.port
const origin = `${ctx.webServer.protocol}//127.0.0.1:${port}`
const launchUrl = ctx.connection.authenticatedUrl(origin) // 带 ?token=...
```

随后原子写入 `remote-gw-state.json`（`0600`）。要点：

- profile loader 会**热加载**新增的行，所以第一次安装不需要重启桌面 App；
- App 每次启动、或 loader 刷新，插件都会重新执行，state 文件因此总是最新的；
- 插件只读不写 Harness 内部状态，失败也只写错误字段，不会影响宿主。

## 4. 网关：口令 → 换 Cookie → 反代

### 4.1 登录

- 访问任何路径，未登录则 302 到 `/__login`；
- 口令用 scrypt 加盐哈希比对（`auth.password` 为 `salt:hash`）；
- 同一 IP 失败 10 次锁 10 分钟；
- 登录成功写入 HMAC-SHA256 签名的 `dshgw` Cookie（HttpOnly、SameSite=Lax，`publicUrl` 为 https 时加 `Secure`）。

### 4.2 换 Harness Cookie

`GET <launchUrl>`（即 `http://127.0.0.1:<port>/?token=...`）返回 303 与 `Set-Cookie: dsh-auth-...`。
网关把这条 Cookie 缓存在内存（5 分钟后主动刷新；上游 401 时强制刷新并重试一次）。
手机端只会看到自己的 `dshgw`，**看不到也拿不到** `dsh-auth-*`。

### 4.3 请求改写

| 头部 | 处理 |
|---|---|
| `Host` | 改写为 `127.0.0.1:<port>`（信任围栏要求） |
| `Origin` / `Referer` | 改写为 `http://127.0.0.1:<port>` |
| `Cookie` | 用缓存中的 `dsh-auth-*` 覆盖 |
| `Set-Cookie`（响应） | 过滤掉 `dsh-auth-*`，不向手机泄露 |

### 4.4 请求体与重试

DSH 的 RPC 全部是 `POST /api/*`。网关按 `Content-Length` 决定策略：

- ≤ 16MB：**整体缓冲**后发送，因此遇到 401 可以安全地重试一次；
- 更大或 chunked：流式 `pipe` 直通，不重试（上传优先）。

> 早期版本曾经用 `req.end()` 直接发包、丢了 body，导致所有 RPC 20 秒超时、界面只剩空壳。这个问题已修复，
> `selftest.mjs` 里也保留了一条 `POST /api/session/list` 的回归检查。

### 4.5 响应

- 普通响应：过滤 hop-by-hop 头后流式转发；
- `text/html`：缓冲、按需解压（gzip/br/deflate）、注入兼容层后返回，并加 `Cache-Control: no-store`；
- WebSocket：`upgrade` 事件里用 `net.connect` 手工拼请求行转发，双向 `pipe`。

## 5. 兼容层

注入的脚本在 `<head>` 之后、所有应用脚本之前执行，内容：

1. 补齐 Chromium 115 缺失的 API：`Promise.withResolvers`、`Array.fromAsync`、`Object/Map.groupBy`、
   `URL.canParse`、`AbortSignal.any`、`Set` 集合方法、非安全上下文下的 `crypto.randomUUID`/`navigator.clipboard`；
2. 客户端诊断：`error`/`unhandledrejection`/资源加载失败/`console.error|warn|log`，以及 5s/12s/20s 的
   `diag` 快照（脚本清单、资源耗时、模块加载队列），POST 回 `/__report` 写入网关日志。

Harness 前端用了 `Promise.withResolvers`（Chrome 119+），OPPO 自带浏览器（HeyTapBrowser，Chromium 115）
因此白屏 —— 兼容层即为解决这类问题。

## 6. 线程与并发

- 单进程、单事件循环；网关不持有 Harness 会话状态，纯转发；
- 并发上限由 Node 默认连接数决定；WebSocket 每个连接一条原始 socket；
- 日志写 stdout（由启动器重定向到 `gateway.log`）。

## 7. 为什么不用“直连 + 保留 Host 的反代”

Harness 的 Cookie audience 是 `127.0.0.1:<port>`，且 `Host` 检查只接受 loopback / 监听地址 / `trustedHosts`。
保留外部 Host 的反代会被 403；所以网关必须改写 Host 并注入 Cookie，这是本方案与普通反代的本质区别。

## 8. 与 `dsh web` 的区别

`dsh --profile web --host <ip> --trusted-host <host> --public-url <url>` 是 DSH 官方的对公网部署方式，
由 DSH 自己发令牌、自己设定信任主机。本项目面向**已经在用桌面版**的用户：不改启动参数、不重启、复用同一实例。
