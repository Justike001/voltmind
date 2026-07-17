# 将 VoltMind 连接到 Claude Code

## 选项 1：本地（推荐，不需要服务器）

```bash
claude mcp add voltmind -- voltmind serve
```

就这样。Claude Code 会把 `voltmind serve` 作为 stdio 子进程启动。不需要服务器、不需要隧道、不需要 token。PGLite 和 Supabase 引擎都可用。

## 选项 2：远程（从任何机器访问）

如果你已经在带公共隧道的服务器上运行 VoltMind（见 [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md)）：

```bash
claude mcp add voltmind -t http \
  https://YOUR-DOMAIN.ngrok.app/mcp \
  -H "Authorization: Bearer YOUR_TOKEN"
```

将 `YOUR-DOMAIN` 替换为你的 ngrok 域名，将 `YOUR_TOKEN` 替换为来自 `voltmind auth create "claude-code"` 的 token。

## 验证

在 Claude Code 中尝试：

```
search for [any topic in your brain]
```

你应该能看到来自 VoltMind 知识库的结果。

## 移除

```bash
claude mcp remove voltmind
```
