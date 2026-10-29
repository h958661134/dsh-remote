# 安全模型

## 威胁模型

要防的是：**在没有局域网、没有端口转发的条件下，把 Harness 暴露给外部设备时，不要让未授权的人拿到
一个能执行任意工具的 agent。**

DeepSeek Harness 本身没有内置的多用户认证；桌面版默认只监听回环地址。本项目的安全边界放在网关这一层。

## 三层凭证

| 凭证 | 位置 | 谁能看到 | 作用 |
|---|---|---|---|
| **访问口令** | `gateway/config.json`（scrypt 加盐哈希） | 只有你 | 手机登录用 |
| **网关会话 Cookie** | 手机浏览器（`dshgw`，HMAC 签名、HttpOnly） | 你的设备 | 30 天免密 |
| **Harness 启动令牌** | `remote-gw-state.json`（`0600`） | 本机当前用户 | 插件导出，网关换 Harness Cookie |
| **Harness Cookie**（`dsh-auth-*`） | **只在网关进程内存** | 网关进程 | 代表 harness 接受 RPC |

设计要点：

- Harness 的 Cookie **不写入磁盘、不发给手机**；手机只持有网关自己的会话 Cookie。
- 口令用 `scrypt(salt, 64)` 加盐哈希存储；比较使用 `timingSafeEqual`。
- 同一 IP 连续失败 10 次锁定 10 分钟（内存计数）。
- 启动令牌只在本机状态文件里，权限 `0600`；该文件等价于本机凭证，**不要提交到 git 或发人**。
- 网关默认只监听 `127.0.0.1`；外部入口必须经过 Tailscale 或隧道。

## 公网暴露时的检查清单

- [ ] 使用**强口令**（≥ 12 位随机；`admin.mjs init` 默认生成 14 位）。
- [ ] 优先让隧道/代理本身带身份层：Cloudflare Access、Tailscale ACL、或只允许你的出口 IP。
- [ ] 不要把 `listenHost` 改成 `0.0.0.0`。
- [ ] 定期看 `gateway.log` 的 `login failed from` 行，异常 IP 直接封。
- [ ] 不用的隧道/网关进程及时关掉。
- [ ] 通过 HTTPS 访问时设置 `publicUrl`，让会话 Cookie 带 `Secure`。

## 凭证轮换与撤销

| 要撤销什么 | 怎么做 |
|---|---|
| 某台手机的登录 | 修改口令 **不足以**让已签发的会话失效；需要轮换 `sessionSecret` 后重启网关（旧 Cookie 立即作废） |
| Harness 侧的会话 | 删除 `$DSH_HOME/.credentials.yaml` 里的 `client-connection/browser-session` 记录并重启 Harness（会同时让你电脑上的浏览器/桌面 App 重新登录） |
| 启动令牌泄露 | 重启桌面 App：端口与令牌都会重新生成 |
| 插件本身 | 删除 `cordis.patch.yml` 里的 `remote-gw` 行（或用 `scripts/uninstall.ps1`），重启 App |

## 明确不做的事

- 不做多用户/多角色（这是个人工具；要多人共享请用 DSH 的 liveshare / `dsh web` 能力）。
- 不在网关里实现代理链或匿名化。
- 不保证对抗已控制你电脑的攻击者：本地恶意程序能读到 state 文件与配置，属于本机信任边界之内。

## 报告漏洞

请通过 GitHub Security Advisories 私下报告，不要公开 issue。修复前请勿公开利用细节。
