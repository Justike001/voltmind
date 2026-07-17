# 部署 VoltMind 远程 MCP 服务器

> **v0.26.0+:** `voltmind serve --http` 发布了完整 OAuth 2.1（client credentials、auth code + PKCE、refresh rotation、可选 DCR）、内嵌在 `/admin` 的 React admin dashboard、带 scope 的操作，以及 live SSE activity feed。
> v0.26 之前的旧 bearer token 仍然可用：`verifyAccessToken` 会回退到 `access_tokens` 表，并把旧 token 追认为 `read+write+admin`。
> 旧回退仅支持 Postgres（`access_tokens` 表只在 Postgres 中存在）；OAuth 表在 PGLite 和 Postgres 上都可用。环境变量和可调默认值见 [SECURITY.md](../../SECURITY.md)。

从任何设备、任何 AI 客户端访问你的 brain。VoltMind 提供两种传输：面向本地 agent 的 `voltmind serve`（stdio），以及面向远程客户端、基于 OAuth 2.1 的 `voltmind serve --http`（v0.26.0+）。

## 三条路径

### 本地 stdio（零设置）

```bash
voltmind serve
```

适用于 Claude Code、Cursor、Windsurf，以及任何支持 stdio 的 MCP 客户端。不需要服务器、不需要隧道、不需要 token。PGLite 和 Postgres 引擎都可用。

### 通过 OAuth 2.1 远程访问（推荐，v0.26.0+）

```bash
voltmind serve --http --port 3131
ngrok http 3131 --url your-brain.ngrok.app
voltmind serve --http --port 3131 --public-url https://your-brain.ngrok.app
```

内置 HTTP 传输，带 OAuth 2.1、带 scope 的操作、位于 `/admin` 的 admin dashboard，以及 live SSE activity feed。零外部依赖。这是唯一能与 ChatGPT 工作的路径（ChatGPT MCP connector 要求 OAuth 2.1 + PKCE）。只要服务器可通过 `http://localhost:<port>` 之外的地址访问，就传入 `--public-url`，使 discovery metadata 中的 OAuth issuer 与客户端实际访问的地址一致（RFC 8414 §3.3）。

支持的客户端：
- **ChatGPT** — 要求 OAuth 2.1 + PKCE。可原生配合 `--http` 使用。
- **Claude Desktop / Cowork** — OAuth 2.1 或旧 bearer token。
- **Perplexity** — OAuth 2.1 client credentials grant。
- **Claude Code, Cursor, Windsurf** — 可使用 OAuth 或旧 bearer。

见下方 [OAuth 2.1 设置](#oauth-21-setup-v100)。

### 使用旧 bearer token 远程访问（v0.26 之前部署）— 仅 Postgres

```
Your AI client (Claude Desktop, Perplexity, etc.)
  → ngrok tunnel (https://YOUR-DOMAIN.ngrok.app)
  → voltmind serve --http  (built-in transport with bearer auth)
  → Postgres (pooler connection or self-hosted)
```

这需要：
1. 一个 Postgres-backed brain（`access_tokens` 表只存在于 Postgres；对 PGLite 安装运行 `voltmind serve --http` 会在启动时快速失败）
2. 一台运行 `voltmind serve --http` 的机器
3. 一个公共隧道（ngrok、Tailscale 或云主机）
4. 通过 `voltmind auth create <name>` 创建的 bearer token

升级到 HTTP server 后，v1.0 前的 token 会被追认为 `read+write+admin` scope，因此不需要迁移。

## OAuth 2.1 设置（v0.26.0+）

### 1. 启动 HTTP 服务器

```bash
voltmind serve --http --port 3131
```

首次启动时，服务器会向 stderr 打印 **admin bootstrap token**：

```
Admin bootstrap token: 3a1f9c...
Open http://localhost:3131/admin and paste it to log in.
```

保存这个 token。打开 `http://localhost:3131/admin` 并粘贴它以访问 dashboard。Dashboard 会显示 live activity、已注册客户端、request logs 和 per-client config export。

> **v0.26.9+:** `mcp_request_log.params` 和 live SSE activity feed 默认使用脱敏摘要 `{redacted, kind, declared_keys, unknown_key_count, approx_bytes}`。
> 声明过的参数键会保留（与 operation spec 求交）；未知键只计数不命名，字节大小向上取整到 1KB，因此 size-probe attack 无法二分搜索秘密内容。个人笔记本上的 operator 如需恢复原始 payload，可传入 `voltmind serve --http --log-full-params`（启动时会有醒目的 stderr warning）。多租户部署应保持脱敏默认值。

### 2. 注册 OAuth clients

从 **`/admin` dashboard** 注册客户端：

1. 点击 **Register client**。
2. 输入名称（例如 `perplexity`、`chatgpt`）。
3. 选择 scopes：`read`、`write`、`admin`（复选框）。
4. 选择 grant type：机器到机器使用 `client_credentials`（Perplexity、Claude Desktop bearer mode），带 PKCE 的浏览器客户端使用 `authorization_code`（ChatGPT）。
5. 对 `authorization_code` 客户端，粘贴 redirect URI。
6. 点击 **Register**。凭据展示弹窗只会显示一次 `client_id`（confidential client 还会显示 `client_secret`）。立即复制或 Download JSON，secret 会以 hash 形式存储，之后不再显示。

或者从 CLI 注册，脚本化时更快：

```bash
voltmind auth register-client perplexity \
  --grant-types client_credentials \
  --scopes "read write"
```

**v0.34 — source-scoped clients。** 多 source brain 可以用新的 `--source` 和 `--federated-read` flag，把某个客户端的写权限限定到一个 source，并把读权限限定到一组精选 source：

```bash
voltmind auth register-client dept-x-agent \
  --grant-types client_credentials \
  --scopes "read write" \
  --source dept-x \
  --federated-read dept-x,shared,parent-canon
```

`--source` 控制写权限：`put_page` / `add_link` / 等只会落到 `dept-x`。`--federated-read` 独立控制读轴；查询会返回任何列出 source 中的行。省略这两个 flag 会得到 v0.33 兼容的 super-client 形态。v0.34 前客户端会在 `voltmind upgrade` 时回填为 `source_id='default'`。

宿主仓库包装器可以用程序注册：

```ts
await oauthProvider.registerClientManual(
  'perplexity',
  ['client_credentials'],
  'read write',
  [],  // redirect_uris, empty for CC
);
```

若要自助客户端注册（Dynamic Client Registration，RFC 7591），用 `--enable-dcr` 启动服务器。DCR 默认关闭。

### 3. 暴露服务器

**v0.34 — 显式 bind。** `voltmind serve --http` 默认绑定 `127.0.0.1`。要接收来自 ngrok 隧道（或任何非 loopback 来源）的连接，请带 `--bind` 重启：

```bash
voltmind serve --http --port 3131 --bind 0.0.0.0 --public-url https://your-brain.ngrok.app
```

如果设置了 `--public-url` 但没有设置 `--bind`，启动时 stderr 会发出 WARN，使“隧道已启动但 agent 得到 ECONNREFUSED”的配置错误足够显眼。

```bash
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 3131 --url your-brain.ngrok.app
```

你的 OAuth issuer URL 会变成 `https://your-brain.ngrok.app`。MCP SDK 的 router 会在 `/.well-known/oauth-authorization-server` 暴露符合规范的 discovery endpoint。

### 4. Scopes 与 localOnly

每个 operation 都标记为 `read | write | admin`。四个 operation 是 `localOnly`，无论 scope 如何都会在 HTTP 上被拒绝：`sync_brain`、`file_upload`、`file_list`、`file_url`。远程 agent 不能触达本地文件系统表面。

| Scope | 允许的内容 |
|-------|---------------|
| `read` | `search`, `query`, `get_page`, `list_pages`, graph traversal |
| `write` | `put_page`, `delete_page`, `add_link`, `add_timeline_entry` |
| `admin` | Client management, token revocation, sweep, local-only ops |

## 旧 Bearer Token 设置

如果你还没准备迁移，可以继续使用 v0.26 前的 bearer token。它们会在 HTTP server 上被追认为 `read+write+admin` scope。

### 1. 设置隧道

完整设置见 [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md)。快速版：

```bash
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 8787 --url your-brain.ngrok.app  # Hobby tier for fixed domain
```

### 2. 创建 access tokens

```bash
# Create a token for each client
voltmind auth create "claude-desktop"

# List all tokens
voltmind auth list

# Revoke a token
voltmind auth revoke "claude-desktop"
```

Token 按客户端创建。给每个设备/app 创建一个。如果泄露，逐个撤销。Token 以 SHA-256 hash 存在你的数据库中。

### 3. 连接你的 AI 客户端

- **ChatGPT:** [setup guide](CHATGPT.md)（OAuth 2.1 + PKCE，要求 `voltmind serve --http`）
- **Claude Code:** [setup guide](CLAUDE_CODE.md)
- **Claude Desktop:** [setup guide](CLAUDE_DESKTOP.md)（必须使用 GUI，而不是 JSON config）
- **Claude Cowork:** [setup guide](CLAUDE_COWORK.md)
- **Perplexity:** [setup guide](PERPLEXITY.md)

### 4. 验证

```bash
voltmind auth test \
  https://YOUR-DOMAIN.ngrok.app/mcp \
  --token YOUR_TOKEN
```

## Operations

全部 30 个 VoltMind operation 都可以远程使用，包括 `sync_brain` 和 `file_upload`（自托管服务器没有超时限制）。

**关于 `file_upload` 的安全说明：** 远程 MCP 调用者被限制在启动 `voltmind serve` 时所在的工作目录内。符号链接、`..` 遍历、以及 cwd 之外的绝对路径都会被拒绝。Page slug 和 filename 会经过 allowlist 校验（字母数字 + 连字符；无控制字符、RTL override 或反斜杠）。本地 CLI 调用者（`voltmind file upload ...`）保留不受限的文件系统访问，因为用户拥有这台机器。

## 部署选项

ngrok、Tailscale Funnel 和云主机（Fly.io、Railway）的对比见 [ALTERNATIVES.md](ALTERNATIVES.md)。

## 故障排查

**"missing_auth" error**
包含 Authorization header：`Authorization: Bearer YOUR_TOKEN`

**"invalid_token" error**
运行 `voltmind auth list` 查看活动 token。

**"service_unavailable" error**
数据库连接失败。检查你的 Supabase dashboard 是否有 outage。

**Claude Desktop doesn't connect**
远程服务器必须通过 Settings > Integrations 添加，而不是 `claude_desktop_config.json`。见 [CLAUDE_DESKTOP.md](CLAUDE_DESKTOP.md)。

## 预期延迟

| Operation | Typical Latency | Notes |
|-----------|----------------|-------|
| get_page | < 100ms | 单次 DB 查询 |
| list_pages | < 200ms | 带 filter 的 DB 查询 |
| search (keyword) | 100-300ms | 全文搜索 |
| query (hybrid) | 1-3s | Embedding + vector + keyword + RRF |
| put_page | 100-500ms | 写入 + trigger search_vector update |
| get_stats | < 100ms | 聚合查询 |

**说明：** `voltmind serve --http` 在 v0.26.0 发布，二进制内置 OAuth 2.1 + admin dashboard。自定义 HTTP wrapper 模式（见 [voice recipe](../../recipes/twilio-voice-brain.md)）仍然支持，需要定制 middleware 的团队可以继续使用；但对大多数远程部署，内置服务器是推荐路径。
