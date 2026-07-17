# 将 VoltMind 连接到 ChatGPT

**状态（v0.26.0）：** 已解除阻塞。VoltMind 的 `voltmind serve --http` 已发布带 PKCE 的 OAuth 2.1，这是 ChatGPT MCP 连接器的硬性要求。在 v1.0 之前，这是一个 P0 TODO，也是唯一一个无法连接的主要 AI 客户端。

ChatGPT 不支持 bearer-token MCP 服务器。你必须使用 OAuth 2.1 HTTP 服务器。

## 设置

### 1. 启动 HTTP 服务器

```bash
voltmind serve --http --port 3131
```

保存 stderr 中打印的 admin bootstrap token。打开 `http://localhost:3131/admin` 并粘贴它以进入 dashboard。

### 2. 注册 ChatGPT 客户端

ChatGPT 使用带 PKCE 的授权码流程（基于浏览器的 OAuth）。从 `/admin` dashboard 注册：

1. 点击 **Register client**。
2. Name: `chatgpt`。
3. Grant type: `authorization_code`。
4. Scopes: `read`, `write`（给 ChatGPT 保持 `admin` 未选中）。
5. Redirect URI: ChatGPT 的 OAuth redirect（从 ChatGPT connector 设置界面复制，类似 `https://chat.openai.com/connector_platform_oauth_redirect`）。
6. 点击 **Register**。凭据展示弹窗会一次性显示 `client_id`，并带有 Copy 和 Download JSON 按钮。基于 PKCE 的 public client 没有 client secret。

宿主仓库包装器也可以用程序注册：

```ts
await oauthProvider.registerClientManual(
  'chatgpt',
  ['authorization_code'],
  'read write',
  ['https://chat.openai.com/connector_platform_oauth_redirect'],
);
```

### 3. 将服务器暴露到公网

```bash
brew install ngrok
ngrok http 3131 --url your-brain.ngrok.app
```

你的 OAuth issuer URL 会变成 `https://your-brain.ngrok.app`。ChatGPT 的 connector 会在 `/.well-known/oauth-authorization-server` 自动发现符合规范的端点。

### 4. 在 ChatGPT 中添加 connector

1. 打开 ChatGPT > Settings > Connectors。
2. 点击 **Add connector**。
3. MCP server URL: `https://your-brain.ngrok.app/mcp`。
4. Client ID: 第 2 步保存的 `client_id`。
5. 点击 **Connect**。ChatGPT 会打开 OAuth consent page，你批准后 connector 即可使用。

开始一段新对话，让 ChatGPT 搜索你的 brain。MCP tool call 会实时显示在 admin dashboard 的 live SSE feed 中。

## Scopes

ChatGPT 客户端可以请求 `read`、`write`、`admin` 的任意组合。授权时授予的 scope 会在每次 tool call 上强制执行。四个操作是 `localOnly`，无论 scope 如何都会在 HTTP 上被拒绝：`sync_brain`、`file_upload`、`file_list`、`file_url`。HTTP 服务器对任何触达本地文件系统表面的尝试都 fail closed。

推荐的 ChatGPT scope：`read write`。把 `admin` 留给本地 CLI 和 admin dashboard。

## 故障排查

**ChatGPT connector OAuth 握手期间出现 "Invalid redirect_uri"**
注册的 `redirect-uri` 必须与 ChatGPT 的完全一致。如果 ChatGPT 拒绝你的服务器，请检查 admin dashboard 的 **Agents** 表，确认 redirect URI 与错误页面显示的内容一致，然后用正确 URI 重新注册。

**批准后 ChatGPT 显示 MCP connection error**
打开 `/admin`，观察 SSE feed，然后重试。如果没有请求到达，说明 connector 没有访问到你的 ngrok URL。如果请求到了但失败，Request Log 标签页会显示确切错误。

**token endpoint 上出现 "Unsupported grant_type"**
ChatGPT 使用 `authorization_code`，MCP SDK 原生支持它。如果看到此错误，请确认客户端注册时使用了 `--grant-types authorization_code`，而不是 `client_credentials`。

## 另见

- [DEPLOY.md](DEPLOY.md) — 完整 OAuth 2.1 设置参考
- [ALTERNATIVES.md](ALTERNATIVES.md) — 隧道选项（ngrok、Tailscale、Fly）
