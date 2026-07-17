# 将 VoltMind 连接到 Perplexity Computer

Perplexity Computer 支持带 bearer token 认证的远程 MCP 服务器。

## 设置

1. 打开 Perplexity（需要 Pro 订阅）
2. 前往 **Settings > Connectors**（或 **MCP Servers**）
3. 添加新的远程 connector：
   - **URL:** `https://YOUR-DOMAIN.ngrok.app/mcp`
   - **Authentication:** API Key / Bearer Token
   - **Token:** 你的 VoltMind access token
     （用 `voltmind auth create "perplexity"` 创建）
4. 保存

将 `YOUR-DOMAIN` 替换为你的 ngrok 域名（设置见 [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md)）。

## 验证

在 Perplexity 对话中，让它使用你的 brain：

```
Use my VoltMind to search for [topic]
```

## 说明

- Perplexity Computer 对 Pro 订阅用户开放
- Perplexity Mac app 和网页版都支持 MCP connector
- 如果你偏好 `voltmind serve`（stdio），Mac app 也支持本地 MCP 服务器
