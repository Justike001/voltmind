# VoltMind HTTP MCP Server 管理指南（无 GUI Ubuntu 环境）

> 适用场景：Ubuntu server 作为 VoltMind `serve --http` 远程 MCP 服务器，无桌面环境。
> 目标：在没有 GUI 的情况下完成 MCP client / OAuth 认证的管理，并可在局域网内
> 通过 Windows 主机的浏览器访问内置 `/admin` 管理台。
>
> 代码依据（本仓库内）：
> - CLI 管理实现：`src/commands/auth.ts`（`runAuth` 列出全部子命令）
> - Web admin + 鉴权：`src/commands/serve-http.ts`（bootstrap token、`/admin/login`、
>   magic-link、cookie 会话）
> - 部署说明：`docs/mcp/DEPLOY.md`
> - 安全说明：`SECURITY.md`

---

## 0. 核心结论

VoltMind **没有**一个独立的交互式 TUI admin 控制台，但有两套等价的管理能力，
都能在无 GUI 的 Ubuntu 上使用：

1. **纯 CLI 管理**：`voltmind auth <子命令>` 全套管理 OAuth 2.1 client 与 legacy
   bearer token，可在 SSH 里直接跑，专为脚本/无头服务器设计。这是主路径。
2. **内置 Web 管理台 `/admin`**：`voltmind serve --http` 内嵌的 React dashboard，
   cookie 鉴权。无头服务器上**不必**在本机拉起浏览器，可让局域网内的 Windows 主机
   远程访问；或用 SSH 端口转发在 Windows 浏览器本地体验。

---

## 1. 方案一：纯 CLI 管理（推荐，无需 GUI）

在 Ubuntu server 上直接执行。覆盖「注册/吊销 client、发/吊销 token、改可见性、
连通性测试」，**不需要任何网页**。

### 1.1 OAuth 2.1 client（推荐，v0.26+）

```bash
# 基础：机机对接（Perplexity、Claude Desktop bearer 模式）
voltmind auth register-client perplexity \
  --grant-types client_credentials \
  --scopes "read write"

# v0.34 多 source brain：写作用域限定到单一 source，读作用域独立放行
voltmind auth register-client dept-x-agent \
  --grant-types client_credentials --scopes "read write" \
  --source dept-x --federated-read dept-x,shared,parent-canon

# 授权码 + PKCE（ChatGPT 这类浏览器客户端）
# 传 --redirect-uri 时，grant-types 自动推断为 authorization_code,refresh_token
voltmind auth register-client chatgpt \
  --redirect-uri https://chatgpt.com/api/auth/callback/mcp

# 公共客户端（PKCE-only，不发 secret）
voltmind auth register-client chatgpt-public \
  --redirect-uri https://chatgpt.com/api/auth/callback/mcp \
  --token-endpoint-auth-method none
```

`register-client` 输出 `client_id`（及机密客户端的 `client_secret`，只显示一次）。

### 1.2 吊销 OAuth client

```bash
voltmind auth revoke-client <client_id>
# 级联删除 oauth_tokens 与 oauth_codes（FK ON DELETE CASCADE）
```

### 1.3 Legacy bearer token（仅 Postgres，会被 grandfather 成 read+write+admin）

```bash
voltmind auth create "claude-desktop"                      # 创建
voltmind auth list                                         # 列表
voltmind auth revoke "claude-desktop"                      # 吊销
voltmind auth permissions "claude-desktop" set-takes-holders world,garry   # 改可见性
```

> 注意：legacy `access_tokens` 表只在 Postgres 上存在；`voltmind serve --http`
> 针对 PGLite 安装会在启动时 fail fast。OAuth 表 PGLite/Postgres 通用。

### 1.4 连通性冒烟测试

```bash
voltmind auth test https://YOUR-DOMAIN/mcp --token YOUR_TOKEN
# 依次验证 initialize / tools/list / tools/call(get_stats)
```

### 1.5 子命令总览

```
voltmind auth create <name> [--takes-holders world,garry,brain]   创建 legacy token
voltmind auth list                                                 列出 token
voltmind auth revoke <name>                                        吊销 legacy token
voltmind auth permissions <name> set-takes-holders <h1,h2,h3>      更新可见性
voltmind auth register-client <name> [options]                     注册 OAuth 2.1 client
   --grant-types <client_credentials,authorization_code>           默认 client_credentials
   --scopes "<read write admin>"                                   默认 read
   --source <id>                                                   默认 default
   --federated-read <id1,id2,...>                                  默认 [source]
   --redirect-uri <https://...>                                    v0.41.3+ 可重复
   --token-endpoint-auth-method <method>                           client_secret_post|client_secret_basic|none
voltmind auth revoke-client <client_id>                            删除 OAuth client
voltmind auth test <url> --token <token>                           冒烟测试远程 MCP
```

---

## 2. 方案二：局域网 Windows 浏览器访问 `/admin`

`/admin` 是 `voltmind serve --http` 内嵌的 SPA（见 `src/admin-embedded.ts`），登录用
**admin bootstrap token**，发 HttpOnly + SameSite=Strict cookie（24h 有效）。

### 2.1 启动配置（关键：默认只绑环回）

v0.34.1 起 `--bind` 默认 `127.0.0.1`，**不接受局域网连接**。要给 Windows 访问必须显式 bind：

```bash
# 推荐：固定 bootstrap token（32+ 字符，匹配 [A-Za-z0-9_-]+）
# 否则每次重启都生成新的随机值，已登录会话全部失效
export VOLTMIND_ADMIN_BOOTSTRAP_TOKEN='<32位以上的强随机串>'

voltmind serve --http --port 3131 \
  --bind 0.0.0.0 \
  --public-url http://<server-LAN-IP>:3131
```

参数说明：

| 参数 / 环境变量 | 作用 | 备注 |
|---|---|---|
| `--bind 0.0.0.0` | 监听所有网卡 | 或用具体网卡 IP `--bind 192.168.x.x` 更收敛 |
| `--bind <ip>` | 仅监听指定网卡 | 最小暴露面 |
| `--public-url` | OAuth issuer / cookie secure 判断依据 | 设了但没设 `--bind` 会打 WARN |
| `VOLTMIND_ADMIN_BOOTSTRAP_TOKEN` | 固定长期 admin 密钥 | 不设则每次启动随机生成 |
| `VOLTMIND_HTTP_CORS_ORIGIN` | OAuth endpoint 跨域 allowlist | dashboard 同源 fetch **不需要**；不设时 OAuth 跨域请求默认拒绝并打 WARN |
| `VOLTMIND_ADMIN_AUTO_LOGIN_LOCAL=1` | loopback 请求自动登录 | 配合 SSH 隧道用，见 2.3 |
| `VOLTMIND_HTTP_TRUST_PROXY` | 信任 X-Forwarded-* | 反向代理/TLS 终端后必须设 |
| `--suppress-bootstrap-token` | 不打印 token 到 stderr | 用了就别再丢随机值 |
| `--enable-dcr` / `--enable-dcr-insecure` | 开放自助注册（RFC 7591） | 默认关，不开则必须 CLI 预注册 |
| `--log-full-params` | 记录原始请求 payload 到日志/SSE | 个人机可开；多租户保持默认 redacted |

启动后 stderr 会打印一个框，内含 `Admin Token`（或显示 `from $VOLTMIND_ADMIN_BOOTSTRAP_TOKEN`）。

### 2.2 三种登录方式（按安全度排序）

#### 方式 A：Magic Link（为"操作员在另一台机器"专门设计，最推荐）

bootstrap token 是长期 admin 密钥，**不应该直接粘进浏览器历史/Referer**。用一次性 nonce：

```bash
# 在 server 上（或任何持有 bootstrap token 的地方）
curl -sX POST http://localhost:3131/admin/api/issue-magic-link \
  -H "Authorization: Bearer $VOLTMIND_ADMIN_BOOTSTRAP_TOKEN"
# => {"url":"http://<server>:3131/admin/auth/<nonce>","expires_in":300}
```

把返回的 URL 在 **Windows 浏览器**打开：

- 5 分钟内有效、**一次性**
- server 验证 nonce → 设 cookie → 重定向到 `/admin/`
- bootstrap token 本身**从不出现在 URL**

端点限速 10 req/min/IP（`adminAuthRateLimiter`），nonce store 有 LRU cap 1000。

#### 方式 B：直接在 Windows 浏览器粘贴 bootstrap token

打开 `http://<server-LAN-IP>:3131/admin`，粘贴 bootstrap token 到登录框
（走 `POST /admin/login`）。简单，但 token 会经过浏览器内存——仅在受信局域网用。

#### 方式 C：SSH 端口转发 + loopback 自动登录（最安全，server 不暴露 admin 端口）

```bash
# 在 Windows 上（或任意 SSH client）
ssh -L 3131:127.0.0.1:3131 user@ubuntu-server
```

server 端设 `VOLTMIND_ADMIN_AUTO_LOGIN_LOCAL=1`，于是来自 `127.0.0.1 / ::1 / localhost`
的请求**自动登录**（判定逻辑见 `serve-http.ts` 的 `isAdminAutoLoginLoopbackRequest`）。
Windows 浏览器开 `http://localhost:3131/admin` 直接进 dashboard。

- server 仍只绑 loopback，LAN 上完全不可见
- 这条对"无 GUI 但又想要网页体验"几乎是最优解

### 2.3 `/admin` 提供的能力

- 实时 SSE 活动流（`/admin/events`）
- 已注册 OAuth client 列表
- 请求日志（`mcp_request_log`，默认 redacted 摘要）
- per-client 配置导出
- 注册 / 吊销 client 的 UI（等价于 CLI）

---

## 3. Scope 与 localOnly 模型

### 3.1 Scope 矩阵

| Scope | 允许的操作 |
|---|---|
| `read` | `search`, `query`, `get_page`, `list_pages`, 图遍历 |
| `write` | `put_page`, `delete_page`, `add_link`, `add_timeline_entry` |
| `admin` | client 管理、token 吊销、sweep、local-only 操作 |

HTTP MCP 仅列出调用方 OAuth scope 允许的操作。

### 3.2 localOnly 操作（HTTP 不可达，无论 scope）

以下 6 个操作只能本地 CLI 调用，远程 agent 碰不到宿主文件系统/维护面：

- `purge_deleted_pages`
- `sync_brain`
- `file_list`
- `file_upload`
- `file_url`
- `code_traversal_cache_clear`

### 3.3 DCR（自助注册）

默认关。需要自助注册（RFC 7591）才开 `--enable-dcr`；多租户/生产环境**建议保持关闭**，
手动 CLI 预注册每个 client。

---

## 4. 安全注意事项

1. **bootstrap token 是长期 admin 密钥**
   - 丢了等于服务器沦陷
   - 务必用 `VOLTMIND_ADMIN_BOOTSTRAP_TOKEN` 设稳定强随机值并妥善保管
   - 不要用 `--suppress-bootstrap-token` 然后又丢了随机值
   - 强度校验：`^[A-Za-z0-9_-]{32,}$`，不达标拒绝启动

2. **HTTP over LAN 的 cookie 不带 Secure**
   - cookie 的 `secure` 标志跟随 issuer 协议（`--public-url` 或请求 TLS 状态）
   - 若 `--public-url http://...`，cookie 不 Secure，明文 HTTP 在不可信 LAN 上可被嗅探
   - 受信局域网可接受；否则上 TLS（反向代理 / Tailscale / ngrok https）并把
     `--public-url` 设成 `https://`

3. **DCR 默认关**：不开时必须 CLI 预注册每个 client，更安全

4. **CORS 默认拒绝**：`VOLTMIND_HTTP_CORS_ORIGIN` 不设时，OAuth endpoint 跨域请求
   全部拒绝；`--bind 0.0.0.0` 但不设 CORS 会打 WARN。dashboard 同源访问不需要它

5. **rate limit**：
   - 预认证 IP：30 req / 60s（`GBRAIN_HTTP_RATE_LIMIT_IP` / 代码 `VOLTMIND_HTTP_*`）
   - 认证后 token：60 req / 60s
   - magic link 端点：10 req / min / IP
   - LRU cap 10000

6. **请求日志默认 redacted**：`mcp_request_log.params` 与 SSE feed 默认输出
   `{redacted, kind, declared_keys, unknown_key_count, approx_bytes}`，
   字节大小向上取整到 1KB 防止 size-probe 攻击。个人机可用 `--log-full-params` 开原始

---

## 5. 推荐做法

- **日常注册/吊销 client** → 直接用 `voltmind auth` CLI，最快、最安全、可脚本化。
- **想要网页可视化**（实时 SSE 活动流、client 列表、请求日志、per-client config 导出）
  → 用**方案二的 SSH 隧道 + loopback 自动登录**（方式 C），server 不暴露端口，
  Windows 浏览器本地体验。内置 `/admin` 基本覆盖了自研 GUI 管理工具的同类功能，
  不必单独维护一个 browser 管理界面。
- 只有在需要给**非 SSH 用户**或**外部 AI 客户端**访问时，才上 `--bind 0.0.0.0`
  + magic link + TLS。

---

## 6. 速查：常用命令

```bash
# ---- CLI 管理 ----
voltmind auth register-client <name> --grant-types client_credentials --scopes "read write"
voltmind auth revoke-client <client_id>
voltmind auth list
voltmind auth test https://YOUR-DOMAIN/mcp --token YOUR_TOKEN

# ---- server 启动（局域网访问）----
export VOLTMIND_ADMIN_BOOTSTRAP_TOKEN='<32位强随机串>'
voltmind serve --http --port 3131 \
  --bind 0.0.0.0 \
  --public-url http://<server-LAN-IP>:3131

# ---- magic link（推荐登录方式）----
curl -sX POST http://localhost:3131/admin/api/issue-magic-link \
  -H "Authorization: Bearer $VOLTMIND_ADMIN_BOOTSTRAP_TOKEN"
# 把返回 url 在 Windows 浏览器打开

# ---- SSH 隧道 + loopback 自动登录（最安全）----
# server 端：VOLTMIND_ADMIN_AUTO_LOGIN_LOCAL=1，--bind 保持默认 127.0.0.1
# Windows 端：
ssh -L 3131:127.0.0.1:3131 user@ubuntu-server
# 然后浏览器开 http://localhost:3131/admin
```
