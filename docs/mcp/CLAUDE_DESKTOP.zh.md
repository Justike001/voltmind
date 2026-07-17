# 将 VoltMind 连接到 Claude Desktop

**重要：** Claude Desktop 不会通过 `claude_desktop_config.json` 连接远程 MCP 服务器。该文件只适用于本地 stdio 服务器。远程 HTTP 服务器必须通过 GUI 添加。

## 设置

1. 打开 Claude Desktop
2. 前往 **Settings > Integrations**
3. 点击 **Add Integration**（或 **Add Connector**）
4. 输入 MCP server URL：
   ```
   https://YOUR-DOMAIN.ngrok.app/mcp
   ```
   将 `YOUR-DOMAIN` 替换为你的 ngrok 域名（设置见 [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md)）。
5. 将 authentication 设为 **Bearer Token**，并粘贴你的 token
   （用 `voltmind auth create "claude-desktop"` 创建）
6. 保存

## 验证

开始一段新对话并尝试：

```
Search my brain for [any topic]
```

Claude Desktop 会自动使用你的 VoltMind 工具。

## 常见错误

**把 claude_desktop_config.json 用于远程服务器** — 这会无声失败，没有错误消息。JSON config 只适用于本地 stdio MCP 服务器。远程 HTTP 服务器必须通过 GUI 中的 Settings > Integrations 添加。

**URL 错误** — 确保 URL 以 `/mcp` 结尾（不是 `/health`，也不是只有基础域名）。
