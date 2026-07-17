# 将 VoltMind 连接到 Claude Cowork

有两种方式把 VoltMind 带入 Cowork session：

## 选项 1：远程（通过自托管服务器 + 隧道）

对于 Team/Enterprise 方案，组织 Owner 添加 connector：

1. 进入 **Organization Settings > Connectors**
2. 添加一个新的 connector，MCP server URL 为：
   ```
   https://YOUR-DOMAIN.ngrok.app/mcp
   ```
3. 在 Advanced Settings 中添加 Bearer token authentication
   （用 `voltmind auth create "cowork"` 创建）
4. 保存

注意：Cowork 从 Anthropic 的云端连接，而不是从你的设备连接。你的服务器必须能被公网访问（ngrok、Tailscale Funnel 或云托管）。

## 选项 2：本地桥接（通过 Claude Desktop）

如果你已经在 Claude Desktop 中配置了 VoltMind（通过 `voltmind serve` stdio 或远程集成），Cowork 会自动获得访问权限。Claude Desktop 会通过它的 SDK 层把本地 MCP 服务器桥接到 Cowork。

这意味着：如果 `voltmind serve` 正在运行并已在 Claude Desktop 中配置，你不需要为 Cowork 准备单独服务器。

## 该用哪一个？

- **远程服务器：** 即使笔记本合上也能工作，可供所有组织成员使用
- **本地桥接：** 如果 Claude Desktop 已经有 VoltMind，几乎零额外设置，但要求你的机器保持运行
