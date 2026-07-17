# 远程 MCP 部署选项

VoltMind 的 MCP 服务器通过 `voltmind serve` 运行（stdio 传输）。如果要让其他设备和 AI 客户端访问它，请在公共隧道后运行 `voltmind serve --http`（内置 HTTP 传输，带 bearer 认证，仅 Postgres……见 [DEPLOY.md](DEPLOY.md)）。下面是可选的隧道方案。

## ngrok（推荐）

[ngrok](https://ngrok.com) 提供即时公共隧道。Hobby 档（$8/月）会给你一个永不变化的固定域名。

```bash
# 1. Install ngrok
brew install ngrok

# 2. Start the built-in HTTP transport
voltmind serve --http --port 8787
# See docs/mcp/DEPLOY.md for token setup

# 3. Expose via ngrok
ngrok http 8787 --url your-brain.ngrok.app
```

完整设置请参见 [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md)，其中包括认证 token 配置和固定域名设置。

## Tailscale Funnel

[Tailscale Funnel](https://tailscale.com/kb/1223/tailscale-funnel) 提供带自动 TLS 的永久公共 HTTPS URL。有免费档。最适合你能控制两端的私有网络。

```bash
# 1. Install Tailscale
brew install tailscale

# 2. Expose your MCP server
tailscale funnel 8787
# Your brain is now at https://your-machine.ts.net
```

## Fly.io / Railway（常驻）

如果生产部署需要在你的机器之外 24/7 运行：

- **Fly.io:** $5-10/月，全球边缘节点，`fly deploy`
- **Railway:** $5/月，git push 部署

两者都原生运行 Bun。不需要打包、不需要 Deno、没有冷启动、没有超时限制。

## 对比

| | ngrok | Tailscale | Fly.io/Railway |
|--|---|---|---|
| 成本 | $8/月（Hobby） | 免费 | $5-10/月 |
| 固定 URL | 是（Hobby） | 是 | 是 |
| 笔记本关机后可用 | 否 | 否 | 是 |
| 冷启动 | 无 | 无 | 无 |
| 超时限制 | 无 | 无 | 无 |
| 全部 30 个操作 | 是 | 是 | 是 |
| 设置时间 | 5 分钟 | 10 分钟 | 15 分钟 |

**说明：** `voltmind serve --http` 是内置 HTTP 传输（v0.22.7+）。它基于 `access_tokens` 表做 Bearer 认证，默认拒绝 CORS，使用双桶限流、请求体上限、逐请求审计日志。按设计仅支持 Postgres（PGLite 仅本地）。环境变量和可调参数见 [DEPLOY.md](DEPLOY.md) 与 [SECURITY.md](../../SECURITY.md)。
