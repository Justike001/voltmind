# VoltMind v0：Postgres-Native Personal Knowledge Brain

## What this is

VoltMind 是一个 compiled intelligence system。它不是笔记应用，也不是“和你的笔记聊天”。

每个页面都是一份 intelligence assessment。线以上是 compiled truth（你当前最好的理解，会在证据变化时重写）；线以下是 timeline（append-only evidence trail）。AI agents 维护 brain。MCP clients 查询它。真正的 intelligence 存在于 fat markdown skills 中，而不是 application code 中。

核心洞见：大规模个人知识是 intelligence 问题，不是 storage 问题。

## Why it exists

一个 7,471-file / 2.3GB 的 markdown wiki 正在拖垮 git。Git 对 wiki-style 使用在约 5K 文件后不再伸缩。compiled truth + timeline 模型（Karpathy-style knowledge pages）是对的，但底层需要真正的数据库。

已有一套 production-grade RAG system（Ruby on Rails、Postgres + pgvector），包含 3-tier chunking、带 RRF 的 hybrid search、multi-query expansion 和 4-layer dedup。VoltMind 把这些验证过的模式移植成独立的 Bun + TypeScript 工具。

## The knowledge model

```
+--------------------------------------------------+
|  Page: concepts/do-things-that-dont-scale         |
|                                                   |
|  --- frontmatter (YAML) ---                       |
|  type: concept                                    |
|  tags: [startups, growth, pg-essay]               |
|                                                   |
|  === COMPILED TRUTH ===                           |
|  Current best understanding.                      |
|  Rewritten on new evidence.                       |
|  This is the "what we know now" section.          |
|                                                   |
|  ---                                              |
|                                                   |
|  === TIMELINE ===                                 |
|  Append-only evidence trail.                      |
|  - 2013-07-01: Published on paulgraham.com        |
|  - 2024-11-15: Referenced in batch kickoff talk   |
|  Never edited, only appended.                     |
+--------------------------------------------------+
          |                    |
          v                    v
  [Semantic chunks]     [Recursive chunks]
  (best quality for     (predictable format
   compiled truth)       for timeline)
          |                    |
          v                    v
     [Embeddings: text-embedding-3-large, 1536 dims]
          |
          v
  [HNSW index + tsvector + pg_trgm]
          |
          v
  [Hybrid search: vector + keyword + RRF fusion]
```

## Architecture decisions

### v0 stack

| Layer | Choice | Why |
|-------|--------|-----|
| Database | Postgres + pgvector | 验证过的 RAG patterns，生产测试过。世界级 hybrid search。 |
| Hosting | Supabase Pro ($25/mo) | 零运维。Managed Postgres、pgvector、connection pooling、8GB storage。 |
| Runtime | Bun + TypeScript | 与 GStack ecosystem 一致。快。可编译为 single binary。 |
| Embeddings | OpenAI text-embedding-3-large | 1536 dims（通过 dimensions API 从 3072 降低）。约 ~$0.13/1M tokens。 |
| LLM (chunking/expansion) | Claude Haiku | 主题边界检测和 query expansion 的最低成本模型。 |
| Background jobs | Trigger.dev | Serverless。Embed backfill、stale detection、orphan audit、tag consistency。 |
| Distribution | npm package + compiled binary + MCP server | OpenClaw 用 library，人类用 CLI，agents 用 MCP。 |

### What we chose and why

**Postgres over SQLite.** 我们已有 3+ 年运行在 Postgres 上的 RAG patterns：tsvector 做全文搜索，pgvector HNSW 做 semantic search，pg_trgm 做 fuzzy slug matching。移植到 SQLite 意味着从头重写 search。SQLite 是未来给 lightweight open source users 的 pluggable engine（见 `docs/ENGINES.md`）。

**Supabase over self-hosted.** 零维护。brain 应该是 AI agents 使用的 infrastructure，而不是你管理的东西。Free tier 有 pgvector 但只有 500MB，不足以容纳 7K+ pages 加 embeddings（约 750MB）。Pro tier $25/mo 提供 8GB。v1 不要求 Docker 或自托管 Postgres。

**Full port over minimal viable.** 这些模式已经被验证。移植是机械性的。一次发布完整 3-tier chunking + hybrid search + 4-layer dedup，意味着从第一天开始就是世界级 RAG。“以后再加”通常意味着以后重建一切。

**Library-first distribution.** voltmind 是 npm package。OpenClaw 以 dependency 安装（`bun add voltmind`），直接 import engine。零额外 function-call overhead、共享 connection pool、TypeScript types。CLI 和 MCP server 都只是同一 engine 上的 thin wrappers。

**Trigger-based tsvector（而非 generated column）。** 要把 timeline_entries 内容包含进全文搜索，tsvector 需要跨多个表。Generated columns 不能跨表引用。pages + timeline_entries 的 trigger 会更新 search_vector。

**Auto-embed during import.** 无需单独 embed step。`voltmind import` 一次完成 chunk 和 embed。progress bar 显示状态。`--no-embed` 给想延后的人。`embedded_at` column 支持 `voltmind embed --stale` backfill。

## Distribution model

```
+-------------------+     +-------------------+     +-------------------+
|   npm package     |     |  Compiled binary  |     |   MCP server      |
|   (library)       |     |  (CLI)            |     |   (stdio)         |
+-------------------+     +-------------------+     +-------------------+
|                   |     |                   |     |                   |
| bun add voltmind    |     | GitHub Releases   |     | voltmind serve      |
| import { Postgres |     | npx voltmind        |     | in mcp.json       |
|   Engine }        |     |                   |     |                   |
|                   |     |                   |     |                   |
| WHO: OpenClaw,    |     | WHO: Humans       |     | WHO: Claude Code,  |
| AlphaClaw         |     |                   |     | Cursor, etc.      |
+-------------------+     +-------------------+     +-------------------+
         |                         |                         |
         +-------------------------+-------------------------+
                                   |
                          +--------v--------+
                          |  BrainEngine    |
                          |  (pluggable     |
                          |   interface)    |
                          +-----------------+
                                   |
                     +-------------+-------------+
                     |                           |
              +------v------+            +-------v-------+
              | Postgres    |            | SQLite        |
              | Engine      |            | Engine        |
              | (v0, ships) |            | (future, see  |
              +-------------+            | ENGINES.md)   |
                                         +---------------+
```

package.json exports：
- Library: `src/core/index.ts`（BrainEngine interface、PostgresEngine、types）
- CLI binary: `src/cli.ts`

## First-time experience

### Path 1：OpenClaw user（primary）

OpenClaw 是使用 voltmind 作为知识后端的 AI orchestrator。这是最常见安装路径。

```bash
# 1. Install voltmind as a ClawHub skill
clawhub install voltmind

# 2. The skill runs guided setup on first use:
#    - Detects if Supabase CLI is available
#    - If yes: auto-provisions a new Supabase project
#    - If no: prompts for connection URL
#    - Runs schema migration
#    - Scans for markdown repos and imports user's content
#    - Shows live entity/edge extraction animation
#    - Brain is ready

# 3. From OpenClaw, brain tools are now available:
#    "Search the brain for [topic from your data]"
#    "Ingest my meeting notes from today"
#    "How many pages are in the brain?"
```

幕后，`clawhub install voltmind` 会安装 npm package、交付 SKILL.md files（ingest、query、maintain、enrich、briefing、migrate）、向 orchestrator 注册 brain tools，并在首次使用时运行 `voltmind init --supabase` guided wizard。

### Path 2：CLI user（standalone）

```bash
# 1. Install
npm install -g voltmind
# or: download binary from GitHub Releases

# 2. Initialize with Supabase
voltmind init --supabase
# Guided wizard:
#   Try 1: Supabase CLI auto-provision (npx supabase)
#   Try 2: If CLI not installed or not logged in, fallback:
#          "Enter your Supabase connection URL:"
#   Then: runs schema migration, verifies pgvector extension
#   Then: verifies database is ready for import
#   Output: "Brain ready. Run: voltmind import <your-repo>"

# 3. Import your data
voltmind import /path/to/markdown/wiki/
# Progress bar: 7,471 files, auto-chunk, auto-embed
# ~30s for text import, ~10-15 min for embedding

# 4. Query
voltmind query "what does PG say about doing things that don't scale?"
```

### Path 3：MCP user（Claude Code、Cursor）

```json
// ~/.config/claude/mcp.json
{
  "mcpServers": {
    "voltmind": {
      "command": "voltmind",
      "args": ["serve"]
    }
  }
}
```

然后在 Claude Code 中：“Search my brain for people who know about robotics”

### The init wizard in detail

```text
Step 1: Database Setup → Supabase CLI 检测、项目创建或手动 URL
Step 2: Schema Migration → 连接数据库、启用 vector/pg_trgm、运行 schema、验证
Step 3: Config → 写入 ~/.voltmind/config.json 并验证连接
Step 4: Kindling Import → 导入 10 篇 bundled PG essays，chunk + embed，并展示 entity/edge extraction
Step 5: First Query → 提示运行一个示例 query
```

每个错误都遵循 style guide：problem + cause + fix + docs link。

## CLI commands

```
voltmind init [--supabase|--url <conn>]     # create brain
voltmind get <slug>                          # read a page
voltmind put <slug> [< file.md]             # write/update a page
voltmind search <query>                      # keyword search (tsvector)
voltmind query <question>                    # hybrid search (RRF + expansion)
voltmind ingest <file> [--type ...]         # ingest a source document
voltmind link <from> <to> [--type <type>]   # create typed link
voltmind unlink <from> <to>                 # remove link
voltmind graph <slug> [--depth 5]           # traverse link graph (recursive CTE)
voltmind backlinks <slug>                    # incoming links
voltmind tags <slug>                         # list tags
voltmind tag <slug> <tag>                    # add tag
voltmind untag <slug> <tag>                  # remove tag
voltmind timeline [<slug>]                   # view timeline
voltmind timeline-add <slug> <date> <text>  # add timeline entry
voltmind list [--type] [--tag] [--limit]    # list with filters
voltmind stats                               # brain statistics
voltmind health                              # brain health dashboard
voltmind import <dir> [--no-embed]          # import from markdown directory
voltmind export [--dir ./export/]           # export to markdown (round-trip)
voltmind embed [<slug>|--all|--stale]       # generate/refresh embeddings
voltmind serve                               # MCP server (stdio)
voltmind call <tool> '<json>'               # raw tool invocation
voltmind upgrade                             # self-update (npm, binary, ClawHub)
voltmind version                             # version info
voltmind config [get|set] <key> [value]     # brain config
```

CLI 和 MCP 暴露相同 operations。Drift tests 会断言两个 interfaces 的所有 operations 结果一致。

## Database schema

Postgres + pgvector 中有 9 张表：`pages`、`content_chunks`、`links`、`tags`、`timeline_entries`、`page_versions`、`raw_data`、`config`、`ingest_log`。核心索引包括 slug unique B-tree、type B-tree、search_vector GIN、frontmatter GIN、title pg_trgm GIN、chunk embedding HNSW、links/tags/timeline 的 B-tree。

## Search architecture

```
Query → Multi-query expansion → embed queries → vector search + keyword search
      → RRF fusion → 4-layer dedup → stale alerts → results
```

4-layer dedup 包括：按 source、cosine > 0.85、type cap 60%、per-page max。

## Chunking strategies

| Strategy | Input | Algorithm | When to use |
|----------|-------|-----------|-------------|
| Recursive | Any text | 5-level delimiter hierarchy，300-word chunks，50-word overlap | Timeline、bulk import |
| Semantic | Quality text | 句子 embedding、Savitzky-Golay filter、cosine minima；fallback recursive | Compiled truth |
| LLM-guided | High-value text | 128-word candidates，Claude Haiku 在 sliding windows 中找 topic shifts | 显式 `--chunker llm` |

Dispatch：compiled_truth 用 semantic chunker，Timeline 用 recursive chunker。可通过 `--chunker` flag 或 frontmatter `chunk_strategy` 覆盖。

## Skills（fat markdown, no code）

每个 skill 都是 AI agents（Claude Code、OpenClaw）读取并执行的 markdown file。skill 包含 workflow、heuristics 和 quality rules。二进制中没有 skill logic。

| Skill | What it does |
|-------|-------------|
| `skills/ingest/SKILL.md` | Ingest meetings、docs、articles。更新 compiled truth、追加 timeline、创建 links。 |
| `skills/query/SKILL.md` | 3-layer search（FTS + vector + structured）。带 citations 综合回答。 |
| `skills/maintain/SKILL.md` | 查找 contradictions、stale info、orphans、dead links、tag inconsistency。 |
| `skills/enrich/SKILL.md` | 从外部 APIs（Crustdata、Happenstance、Exa）丰富信息。保存 raw data，提炼为 compiled truth。 |
| `skills/briefing/SKILL.md` | Daily briefing：带上下文的 meetings、active deals、open threads。 |
| `skills/migrate/SKILL.md` | 从 Obsidian、Notion、Logseq、plain markdown、CSV、JSON、Roam 通用迁移。 |

## CEO scope expansions（v0 接受）

1. **CLI/MCP parity with drift tests.**
2. **Smart slug resolution.**
3. **Brain health dashboard.**
4. **Normalized timeline.**
5. **Page version control.**
6. **Typed links + graph traversal.**
7. **Trigger.dev data cleanup jobs.**
8. **Stale alert annotations.**
9. **Timeline merge on ingest.**

## Security model（v0）

单用户、本地优先：
- Supabase service role key 存在 `~/.voltmind/config.json`（0600 permissions）
- MCP stdio transport 本质上是本地的（client 以 subprocess 启动 `voltmind serve`）
- v0 无 multi-user、无 RLS、无 OAuth
- 未来 multi-user path：Supabase RLS + per-user API keys

## Upgrade mechanism

`voltmind upgrade` 会检测安装方式并相应更新：

| Path | How |
|------|-----|
| npm | `bun update voltmind`（或 npm equivalent） |
| Compiled binary | 下载新 binary 到 temp dir，atomic rename swap，exec new process |
| ClawHub | `clawhub update voltmind` |

Version check：比较 local version 与 latest GitHub release tag。

## Storage and cost estimates

### Storage（7,471 pages 约 750MB）

| Component | Size |
|-----------|------|
| Page text (compiled_truth + timeline) | ~150MB |
| JSONB frontmatter | ~20MB |
| tsvector + GIN indexes | ~50MB |
| Content chunks (~22K, text) | ~80MB |
| Embeddings (22K x 1536 floats x 4 bytes) | ~134MB |
| HNSW index overhead (~2x embeddings) | ~270MB |
| Links, tags, timeline, raw_data, versions | ~50MB |
| **Total** | **~750MB** |

Supabase free tier（500MB）放不下。Supabase Pro（$25/mo, 8GB）是起点。

### Embedding cost（初始 import 约 $4-5）

| Step | Cost |
|------|------|
| Semantic chunker sentence embeddings (~374K sentences) | ~$1 |
| Chunk embeddings (~22K chunks) | ~$0.30 |
| Query expansion (per query, ~3 embeds) | negligible |
| **Total initial import** | **~$4-5** |

预算替代方案：`voltmind import --chunker recursive` 跳过 sentence-level embeddings，之后用 `voltmind embed --rechunk --chunker semantic` 升级。

## Serverless operations stack

```
Supabase (Postgres + pgvector) + Vercel (optional web/API) + Trigger.dev (background jobs)
```

CLI 直接连接 Supabase Postgres。Trigger.dev 和 Vercel 用于 async/scheduled work。没有它们 CLI 也能工作。

## Verification checklist

1. `voltmind import /data/brain/` 无损迁移所有 7,471 files
2. `voltmind export` round-trip 到语义相同的 markdown
3. `voltmind query "what does PG say about doing things that don't scale?"` 返回相关 hybrid search results
4. `voltmind serve` 启动可由 Claude Code 连接的 MCP server
5. 所有 3 个 chunkers 使用 test fixtures 产生正确输出
6. `voltmind init --supabase` 端到端可用
7. `bun test` 通过所有 tests
8. `clawhub install voltmind` 安装 skill 并运行 guided setup
9. `bun add voltmind` + `import { PostgresEngine } from 'voltmind'` 在外部项目可用
10. Drift tests 通过：CLI 和 MCP 产生相同结果
11. `voltmind health` 输出准确 brain health metrics
12. Migration skill 成功导入 Obsidian vault

## Future plans

可插拔 engine 架构和未来 backend 计划见 `docs/ENGINES.md`。

### v1 candidates（从 v0 defer）

- **`voltmind ask` natural language CLI alias.**
- **Intelligence compiler.** 把每个 fact 视为带 source span、entity links、validity window、confidence 和 contradiction status 的 first-class claim。
- **Active skills via Trigger.dev.**
- **Multi-user access.**
- **SQLite engine.**
- **Docker Compose for self-hosted Postgres.**
- **Web UI.**

### Interface abstraction principle

所有操作都经过 `BrainEngine`。engine interface 是契约。Postgres-specific features（tsvector、pgvector HNSW、pg_trgm、recursive CTEs）都是 `PostgresEngine` 内部实现细节。接口暴露 capabilities，而不是 SQL。

这意味着 CLI、MCP server 和 library consumers 永远不需要知道底层运行的是哪个 engine。完整 interface spec 见 `docs/ENGINES.md`，SQLite 实现计划见 `docs/SQLITE_ENGINE.md`。

## Review history

| Review | Runs | Status | Key findings |
|--------|------|--------|-------------|
| /office-hours | 1 | APPROVED | Builder mode. Full port approach chosen. |
| /plan-ceo-review | 1 | CLEAR | 11 proposals, 10 accepted, 1 deferred. SCOPE EXPANSION mode. |
| /codex review | 1 | issues_found | 24 points challenged, 3 accepted (fuzzy slug, revert spec, tsvector). |
| /plan-eng-review | 2 | CLEAR | 3 issues (upgrade paths, import guardrails, init wizard), 0 critical gaps. |
| /plan-devex-review | 1 | CLEAR | DX score 5/10 to 7/10. TTHW 25min to 90s. Champion tier. |
