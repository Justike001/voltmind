# VoltMind Deployment Topologies

VoltMind 支持三种部署形态。它们可以组合：单个用户可以在同一台机器上混用全部三种，
且不会冲突，因为每种形态最终都会解析为“当前哪个 `~/.voltmind/config.json`
处于活动状态？”而 `VOLTMIND_HOME` 控制这个选择。

本页说明三种 topologies、各自适用场景，以及具体 setup recipes。请将本文与
`docs/architecture/brains-and-sources.md` 配套阅读（后者讲 brain 内部的组织轴）—
那篇文档回答 WHICH database；本文回答 WHERE that database lives。

## Quick decision tree

```
   "I'm setting up voltmind..."
        │
        ▼
  Just for me, on one machine? ─── yes ───▶ Topology 1 (single brain)
        │
        no
        │
        ▼
  Will a remote machine host the brain
  while my agent runs locally? ──── yes ───▶ Topology 2 (cross-machine thin client)
        │
        no
        │
        ▼
  Multiple Conductor worktrees that
  shouldn't share a code index? ─── yes ───▶ Topology 3 (split-engine)
```

Topologies 2 和 3 可以叠加：thin-client 安装也可以托管 per-worktree code engines，
而 per-worktree code engine 也可以把 artifact brain 指向远程服务器。

## Topology 1 — Single brain（当前默认）

```
  ┌────────────────┐
  │   one machine  │
  │  ┌──────────┐  │
  │  │  voltmind  │──┼──→  ~/.voltmind/  →  PGLite  or  Supabase
  │  │   CLI    │  │
  │  └──────────┘  │
  └────────────────┘
```

你得到的是：一个本地 DB（小 brains 用 PGLite，约 1000+ files 用 Supabase）。
所有命令都直接针对它运行。`voltmind serve` 通过 MCP 将它暴露给单个 agent。

适用场景：个人使用、单机、一个 agent、没有 Conductor 并行。这是默认值；
`voltmind init`（无 flags）会给你这种形态。

Setup:

```
voltmind init           # interactive — defaults to PGLite
voltmind init --pglite  # explicit local
voltmind init --supabase  # remote Supabase (recommended for 1000+ files)
```

这里没有别的特殊之处。另两种 topologies 都是围绕“谁拥有 DB”和“agent 如何与它通信”的变体。

## Topology 2 — Cross-machine thin client

```
  ┌────────────┐                    ┌──────────────────┐
  │ neuromancer│                    │    brain-host    │
  │ ┌────────┐ │ HTTP MCP / OAuth   │  ┌────────────┐  │
  │ │ Hermes │─┼───────────────────→│  │   voltmind   │──┼──→ Supabase
  │ │ agent  │ │                    │  │ serve --http│  │
  │ └────────┘ │                    │  └────────────┘  │
  │            │                    │   (with autopilot)│
  │  no local  │                    │                  │
  │  voltmind DB │                    │                  │
  └────────────┘                    └──────────────────┘
```

你得到的是：一台机器（“neuromancer”）上的 agent 通过带 OAuth 的 HTTP MCP
消费另一台机器（“brain-host”）上托管的 brain。agent 所在机器没有本地 engine。
所有 queries、searches、embeddings 和 indexing 都在 host 上发生。

适用场景：

- Heavy brain（Supabase + autopilot）位于更强的机器上；其他地方的 agents 只消费它。
- 你希望多台机器共享一个 source of truth。
- 启动一个并行本地安装会造成 source-ID contention 或重复工作。

thin client 的 `~/.voltmind/config.json` 包含 `remote_mcp` 字段，而不是本地 DB 连接：

```jsonc
{
  "engine": "postgres",  // ignored — never used
  "remote_mcp": {
    "issuer_url": "https://brain-host.local:3001",
    "mcp_url":    "https://brain-host.local:3001/mcp",
    "oauth_client_id": "neuromancer-...",
    "oauth_client_secret": "..."  // or set VOLTMIND_REMOTE_CLIENT_SECRET
  }
}
```

CLI dispatch guard 会拒绝 thin-client 安装上的所有 DB-bound commands
（`sync`、`embed`、`extract`、`migrate`、`apply-migrations`、`repair-jsonb`、
`orphans`、`integrity`、`serve`），并给出清晰错误指向 remote host。
`voltmind doctor` 会运行专门的 thin-client check set（OAuth discovery、
token round-trip、MCP smoke）。

### Setup

**Step 1 — On the host (brain-host):**

```bash
voltmind init --supabase                         # or --pglite, doesn't matter
voltmind serve --http --port 3001 --bind 0.0.0.0 # v0.34: bind explicitly for remote access
                                                # (defaults to 127.0.0.1 since v0.34)
voltmind auth register-client neuromancer \
  --grant-types client_credentials \
  --scopes read,write,admin                    # admin needed for ping/doctor

# v0.34: source-scoped client (write to one source, federate reads across
# multiple sources). Omit both flags for a v0.33-compatible super-client.
voltmind auth register-client neuromancer-dept \
  --grant-types client_credentials \
  --scopes read,write \
  --source dept-x \
  --federated-read dept-x,shared,parent-canon
```

`register-client` 命令会打印 `client_id` 和 `client_secret`。记下两者。
**Scope 必须包含 `admin`** — `submit_job`（`voltmind remote ping` 使用）和
`run_doctor`（`voltmind remote doctor` 使用）都需要它。

**Step 2 — On the thin client (neuromancer):**

```bash
voltmind init --mcp-only \
  --issuer-url https://brain-host.local:3001 \
  --mcp-url https://brain-host.local:3001/mcp \
  --oauth-client-id <id> \
  --oauth-client-secret <secret>
```

Pre-flight smoke 会运行三个 probes（OAuth discovery、token round-trip、
MCP initialize）。任一失败，init 都会带可操作错误退出。成功后，
`~/.voltmind/config.json` 会设置 `remote_mcp`，并且不会创建本地 DB。

**Step 3 — Configure your agent's MCP client.**

对于 Claude Desktop / Hermes / openclaw，增加一个 MCP server entry，
指向 host 的 `mcp_url`，并带上来自 `register-client` 的 bearer token。
Claude Desktop 的 `~/.config/claude/claude_desktop_config.json` 示例：

```jsonc
{
  "mcpServers": {
    "voltmind": {
      "type": "url",
      "url": "https://brain-host.local:3001/mcp",
      "headers": { "Authorization": "Bearer <client_secret>" }
    }
  }
}
```

**Step 4 — Verify.**

```bash
voltmind doctor             # runs thin-client checks (no local DB needed)
voltmind remote ping        # triggers an autopilot cycle on the host (Tier B)
voltmind remote doctor      # asks the host to run its own doctor (Tier B)
```

`voltmind sync` 及同类命令会拒绝执行，并给出清晰 thin-client error，命名
`mcp_url`。这是正确行为 — 这些命令需要本地 engine，而这里不存在。

### Re-run guard

在已有 thin-client config 的机器上运行 `voltmind init`（无 flags）会拒绝，
除非带 `--force`。这能捕获 scripted-setup-loop 的摩擦：orchestrator
反复试图创建本地 DB。使用 `voltmind init --mcp-only --force` 刷新 thin-client config。

### Storing the OAuth secret

三个存储路径，按优先级：

1. **`VOLTMIND_REMOTE_CLIENT_SECRET` env var**（headless agents 推荐）。
   设置后会覆盖 config file 中的值。若 env var 是来源，init flow 不会持久化一份
   config-file copy。
2. **带 0600 perms 的 `~/.voltmind/config.json`**（interactive setup 默认；
   与当前 Supabase keys 的存储方式一致）。
3. macOS Keychain integration 在 roadmap 上；v1 中没有。

## Topology 3 — Split-engine, per-worktree code + remote artifacts

```
  ┌──────────────────────────────────────────────────────┐
  │                  one machine                         │
  │                                                      │
  │  ┌─ worktree A ──────────────┐                       │
  │  │  VOLTMIND_HOME=A/.conductor │                       │
  │  │  voltmind serve --port 3001 │── PGLite (code A)     │
  │  └───────────────────────────┘                       │
  │                                                      │
  │  ┌─ worktree B ──────────────┐                       │
  │  │  VOLTMIND_HOME=B/.conductor │                       │
  │  │  voltmind serve --port 3002 │── PGLite (code B)     │
  │  └───────────────────────────┘                       │
  │                                                      │
  │  ┌─ default ~/.voltmind ───────┐    HTTP MCP / OAuth   │
  │  │  voltmind serve --port 3000 │──────────────────────→ remote artifacts
  │  └───────────────────────────┘                        (Supabase / brain-host)
  │                                                      │
  │  Agent's MCP config (Hermes / Claude Desktop):       │
  │    mcp__voltmind_code__*       → http://localhost:3001 │
  │    mcp__voltmind_artifacts__*  → http://brain-host/mcp │
  └──────────────────────────────────────────────────────┘
```

你得到的是：每个 Conductor worktree 都有自己的 per-worktree code index
（本地 PGLite，worktree 消失时可丢弃）。Artifacts（plans、learnings、
transcripts）仍然存在于所有 worktrees 都能看到和写入的共享 brain 中。

适用场景：

- 一台机器上有多个 Conductor worktrees，且都在处理同一个 code repo。
- 你不希望每个 worktree 的 code-import 覆盖其他 worktree 的 `last_commit`、
  source IDs 或 symbol tables。
- 你确实希望 artifacts（plans、learnings、retros、transcripts）在 worktrees
  之间可见。

### How it works

`VOLTMIND_HOME` 选择哪个 `~/.voltmind` 目录处于活动状态。按 worktree 设置：

```bash
export VOLTMIND_HOME=/path/to/worktree-A/.conductor/voltmind
voltmind init --pglite
voltmind serve --http --port 3001
```

每个 worktree 的 `voltmind serve` 实例绑定自己的 port，并索引自己的 DB。
多个 `voltmind serve` 进程可以共存 — 它们是独立 OS processes，拥有独立 config
和独立 connection pools。

artifact brain 作为单独的 `voltmind serve` 实例运行，使用默认 `~/.voltmind`
（不覆盖 VOLTMIND_HOME）— 或者是远程的，此时它就是 Topology 2 setup。

agent 的 MCP client config 列出多个 servers，每个都有唯一 alias。Tool names
以 `mcp__<alias>__<tool>` 命名空间化，所以 agent 调用
`mcp__voltmind_code__search` 做 code lookup，调用 `mcp__voltmind_artifacts__search`
做 artifact lookup。

### CRITICAL: alias-level routing is manual

Topology 3 在 voltmind 内部没有智能 per-tool routing。agent 在选择 alias 时
决定查询哪个 brain。**错误 alias 会静默写入（或查询）错误 brain。**
这是刻意的（显式优于魔法），但风险真实存在：

- 如果 agent 用 code-shaped content 调用 `mcp__voltmind_artifacts__put_page`，
  该页面会永久落入 artifact brain。
- 如果 agent 对一个实际需要 artifact context 的问题调用
  `mcp__voltmind_code__search`，搜索会返回空。

缓解措施：

- 清晰命名 aliases。`voltmind_code` vs `voltmind_artifacts` 是明确的；
  `voltmind` vs `voltmind_local` 不是。
- 在 agent 的 system prompt 或 rules 中记录哪个 alias 去哪里。
  明确写出 “code questions → `voltmind_code`; everything else →
  `voltmind_artifacts`.”
- 将 Topology 3 与 `gstack` 的 per-worktree wiring 配套使用（它会在 worktrees
  间一致地设置 alias names + agent rules）。

### Setup（manual；gstack 会自动化这一侧）

voltmind 侧不需要新代码 — `VOLTMIND_HOME` 和 `--port` 已存在。Setup 如下：

```bash
# Start the artifact brain (default ~/.voltmind) on port 3000
voltmind serve --http --port 3000 &

# Start a per-worktree code brain on port 3001
export VOLTMIND_HOME=/path/to/worktree-A/.conductor/voltmind
voltmind init --pglite
voltmind serve --http --port 3001 &
unset VOLTMIND_HOME
```

然后用两个 entries 配置 agent 的 MCP config（不同 aliases，不同 ports）。
Claude Desktop 示例：

```jsonc
{
  "mcpServers": {
    "voltmind_artifacts": {
      "type": "url",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer <token-A>" }
    },
    "voltmind_code": {
      "type": "url",
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer <token-B>" }
    }
  }
}
```

gstack 侧 wiring（per-worktree home setup、port allocation、automatic MCP
config generation、per-worktree DB 的 gitignore）位于 gstack repo 的
setup-voltmind skill — 它组合这些 primitives，voltmind 不需要知道 Conductor。

## Combining topologies

这三种形态可以组合。单台机器可以运行：

- 一个指向远程 artifact brain 的 thin-client default config（Topology 2）。
- 以及各自 `VOLTMIND_HOME` 下的 per-worktree code brains（Topology 3）。
- 每个 worktree 的 `voltmind serve` 实例都是本地的；agent 的 MCP config
  将它们与远程 artifact brain 并列列出。

`VOLTMIND_HOME` 控制任意一次 CLI invocation 使用哪个 config file。
`voltmind serve --port` 控制 server 监听哪个 port。agent 的 MCP client
选择 alias，因此逐 tool call 决定目的地。不存在一个同时了解所有这些实例的
全局 voltmind orchestrator — 这是有意为之。

## When NOT to use these topologies

- **如果你的 agent 永远只在 brain 所在机器上运行，不要使用 Topology 2。**
  本地 `voltmind` 安装 + `voltmind serve`（stdio）更简单、更快。
- **如果你一次只有一个 Conductor worktree，不要使用 Topology 3。**
  Per-worktree engines 是为了避免 contention；一次一个就没有 contention。
- **不要在同一个 `VOLTMIND_HOME` 中同时使用 `remote_mcp` thin client 和本地 engine。**
  设置 `remote_mcp` 时，dispatch guard 会拒绝 DB-bound commands。如果你确实想在同一台机器上同时使用两种模式，
  用 `VOLTMIND_HOME` 分离它们（一个 home 给 thin client，另一个给 local engine）。

## See also

- `docs/architecture/brains-and-sources.md` — brain 内组织（brains vs sources 轴）。
- `docs/mcp/CLAUDE_DESKTOP.md` and siblings — per-client MCP setup。
- `voltmind init --help` 和 `voltmind auth --help` 获取命令级细节。
