# 可插拔 Engine 架构

## 核心想法

每个 VoltMind 操作都经过 `BrainEngine`。engine 是“brain 能做什么”和“它如何存储”之间的契约。替换 engine，其余部分保持不变。

v0 发布了由 Supabase 支撑的 `PostgresEngine`。v0.7 增加 `PGLiteEngine`，即通过 WASM（@electric-sql/pglite）嵌入的 Postgres 17.5，作为零配置默认值。接口设计使 `DuckDBEngine`、`TursoEngine` 或任何自定义后端都能接入，而无需改 CLI、MCP server、skills 或任何消费方代码。

## 为什么重要

不同用户有不同约束：

| User | Needs | Best engine |
|------|-------|-------------|
| Getting started | 零配置、无账号、无服务器 | PGLiteEngine（v0.7 起默认） |
| Power user (you) | 世界级搜索、7K+ 页面、零运维 | PostgresEngine + Supabase |
| Open source hacker | 单文件、无服务器、git-friendly | PGLiteEngine |
| Team/enterprise | 多用户、RLS、审计轨迹 | PostgresEngine + self-hosted |
| Researcher | 分析、批量导出、embeddings | DuckDBEngine（未来） |
| Edge/mobile | 离线优先、之后同步 | PGLiteEngine + sync（未来） |

engine 接口意味着我们不必二选一。PGLite 是零摩擦默认值。Supabase 是生产规模路径。`voltmind migrate --to supabase/pglite` 可在两者之间迁移。

## The interface

```typescript
// src/core/engine.ts

export interface BrainEngine {
  // Lifecycle
  connect(config: EngineConfig): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T>;

  // Pages CRUD
  getPage(slug: string): Promise<Page | null>;
  putPage(slug: string, page: PageInput): Promise<Page>;
  deletePage(slug: string): Promise<void>;
  listPages(filters: PageFilters): Promise<Page[]>;

  // Search
  searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]>;

  // Chunks
  upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void>;
  getChunks(slug: string): Promise<Chunk[]>;

  // Links
  addLink(from: string, to: string, context?: string, linkType?: string): Promise<void>;
  removeLink(from: string, to: string): Promise<void>;
  getLinks(slug: string): Promise<Link[]>;
  getBacklinks(slug: string): Promise<Link[]>;
  traverseGraph(slug: string, depth?: number): Promise<GraphNode[]>;

  // Tags
  addTag(slug: string, tag: string): Promise<void>;
  removeTag(slug: string, tag: string): Promise<void>;
  getTags(slug: string): Promise<string[]>;

  // Timeline
  addTimelineEntry(slug: string, entry: TimelineInput): Promise<void>;
  getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]>;

  // Raw data
  putRawData(slug: string, source: string, data: object): Promise<void>;
  getRawData(slug: string, source?: string): Promise<RawData[]>;

  // Versions
  createVersion(slug: string): Promise<PageVersion>;
  getVersions(slug: string): Promise<PageVersion[]>;
  revertToVersion(slug: string, versionId: number): Promise<void>;

  // Stats + health
  getStats(): Promise<BrainStats>;
  getHealth(): Promise<BrainHealth>;

  // Ingest log
  logIngest(entry: IngestLogInput): Promise<void>;
  getIngestLog(opts?: IngestLogOpts): Promise<IngestLogEntry[]>;

  // Config
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;

  // Migration + advanced (added v0.7)
  runMigration(sql: string): Promise<void>;
  getChunksWithEmbeddings(slug: string): Promise<ChunkWithEmbedding[]>;
}
```

### 关键设计选择

**基于 slug 的 API，而不是基于 ID。** 每个方法接收 slug，不接收数字 ID。engine 在内部把 slug 解析为 ID。这样接口更可移植：slug 是字符串，而 ID 具有数据库特定性。

**Embedding 不属于 engine。** engine 存储 embeddings 并按向量搜索，但不生成 embeddings。`src/core/embedding.ts` 负责生成。这是有意的：embedding 是外部 API 调用（OpenAI），不是存储关注点。所有 engine 共用同一个 embedding service。

**Chunking 不属于 engine。** 同理，`src/core/chunkers/` 负责 chunking。engine 只存取 chunks。所有 engine 共用同一套 chunkers。

**搜索返回 `SearchResult[]`，不是原始行。** engine 负责自己的搜索实现（tsvector vs FTS5，pgvector vs sqlite-vss），但必须返回统一结果类型。RRF fusion 和 dedup 发生在 engine 之上，即 `src/core/search/hybrid.ts`。

**`traverseGraph` 存在但由 engine 具体实现。** Postgres 使用 recursive CTE。SQLite 可用带深度跟踪的循环。接口相同：给我一个 slug 和最大深度，返回 graph。

## 跨 engine 的搜索工作方式

```
                        +-------------------+
                        |  hybrid.ts        |
                        |  (RRF fusion +    |
                        |   dedup, shared)  |
                        +--------+----------+
                                 |
                    +------------+------------+
                    |                         |
           +--------v--------+       +--------v--------+
           | engine.search   |       | engine.search   |
           |   Keyword()     |       |   Vector()      |
           +-----------------+       +-----------------+
                    |                         |
        +-----------+-----------+   +---------+---------+
        |                       |   |                   |
+-------v-------+  +-------v---+   +-------v---+  +----v--------+
| Postgres:     |  | PGLite:   |   | Postgres: |  | PGLite:     |
| tsvector +    |  | tsvector +|   | pgvector  |  | pgvector    |
| ts_rank +     |  | ts_rank   |   | HNSW      |  | HNSW        |
| websearch_to_ |  | (same SQL)|   | cosine    |  | cosine      |
| tsquery       |  |           |   |           |  | (same SQL)  |
+---------------+  +-----------+   +-----------+  +-------------+
```

RRF fusion、多查询扩展和四层 dedup 都与 engine 无关。它们操作 `SearchResult[]` 数组。只有原始 keyword 和 vector search 是 engine-specific。

## PostgresEngine（v0，已发布）

**Dependencies:** `postgres` (porsager/postgres), `pgvector`

**使用的 Postgres-specific 功能：**
- `tsvector` + `GIN` index，用 `ts_rank` 权重做全文搜索
- `pgvector` HNSW index，用 cosine similarity 做向量搜索
- `pg_trgm` + `GIN` 做 fuzzy slug resolution
- Recursive CTEs 做 graph traversal
- Trigger-based search_vector（横跨 pages + timeline_entries）
- JSONB frontmatter + GIN index
- 通过 Supabase Supavisor（port 6543）做 connection pooling

**Hosting:** Supabase Pro（$25/mo）。零运维。托管 Postgres，内建 pgvector。

**为什么 v0 不做 self-hosted：** brain 应该是 agent 使用的基础设施，而不是你维护的东西。Docker 自托管 Postgres 欢迎社区 PR，但 v0 优化的是零运维。

## PGLiteEngine（v0.7，已发布）

**Dependencies:** `@electric-sql/pglite` (v0.4.4+)

**它是什么：** 通过 ElectricSQL 的 PGLite 把 Postgres 17.5 编译为 WASM 后嵌入运行。进程内、无服务器、无 Docker、无账号。与 PostgresEngine 使用相同 SQL，不是单独方言。全部 37 个 BrainEngine 方法都已实现。

**PGLite-specific 细节：**
- 使用 `pglite-schema.ts` 做 DDL（pgvector extension、pg_trgm、triggers、indexes）
- 全程参数化查询（共享工具在 `src/core/utils.ts`）
- 未设置 `OPENAI_API_KEY` 时，`hybridSearch` keyword-only fallback
- 数据存储在 `~/.voltmind/brain.db`（可配置）
- pgvector HNSW index 用于 cosine similarity vector search（与 Postgres 相同）
- tsvector + ts_rank 用于全文搜索（与 Postgres 相同）
- pg_trgm 用于 fuzzy slug resolution（与 Postgres 相同）

**何时用 PGLite vs Postgres：**

| Factor | PGLite | PostgresEngine + Supabase |
|--------|--------|--------------------------|
| Setup | `voltmind init`（零配置） | 账号 + connection string |
| Scale | 适合 < 1,000 files | 10K+ 生产验证 |
| Multi-device | 仅单机 | 任何设备 via remote MCP |
| Cost | 免费 | Supabase Pro ($25/mo) |
| Concurrency | 单进程 | Connection pooling |
| Backups | 手动（文件复制） | Supabase 托管 |

**Migration:** `voltmind migrate --to supabase` 导出所有内容（pages、chunks、embeddings、links、tags、timeline）并导入 Supabase。`voltmind migrate --to pglite` 反向迁移。双向、无损。

## 添加新 engine

1. 创建 `src/core/<name>-engine.ts`，实现 `BrainEngine`
2. 添加到 `src/core/engine-factory.ts` 的 engine factory：
   ```typescript
   export function createEngine(type: string): BrainEngine {
     switch (type) {
       case 'pglite': return new PGLiteEngine();
       case 'postgres': return new PostgresEngine();
       case 'myengine': return new MyEngine();
       default: throw new Error(`Unknown engine: ${type}`);
     }
   }
   ```
   factory 使用 dynamic imports，因此只在选中时加载对应 engine。
3. 在 `~/.voltmind/config.json` 存储 engine type：`{ "engine": "myengine", ... }`
4. 添加测试。测试套件应尽量 engine-agnostic：相同测试用例，不同 engine constructor。
5. 在本文件中记录，并在 `docs/` 添加设计文档。

### 你不需要改的地方

- `src/cli.ts`（分发到 engine，不知道具体是哪一个）
- `src/mcp/server.ts`（同上）
- `src/core/chunkers/*`（跨 engine 共享）
- `src/core/embedding.ts`（跨 engine 共享）
- `src/core/search/hybrid.ts`, `expansion.ts`, `dedup.ts`（共享，操作 SearchResult[]）
- `skills/*`（fat markdown，engine-agnostic）

### 你需要实现的地方

`BrainEngine` 的每个方法。完整接口。没有 optional methods，没有 feature flags。如果你的 engine 不能做 vector search（例如纯文本 engine），实现 `searchVector` 返回 `[]`，并记录限制。

## Capability matrix

| Capability | PostgresEngine | PGLiteEngine | Notes |
|-----------|---------------|-------------|-------|
| CRUD | Full | Full | Same SQL |
| Keyword search | tsvector + ts_rank | tsvector + ts_rank | Identical (real Postgres) |
| Vector search | pgvector HNSW | pgvector HNSW | Identical (real Postgres) |
| Fuzzy slug | pg_trgm | pg_trgm | Identical (real Postgres) |
| Graph traversal | Recursive CTE | Recursive CTE | Same SQL |
| Transactions | Full ACID | Full ACID | Both support this |
| JSONB queries | GIN index | GIN index | Identical |
| Concurrent access | Connection pooling | Single process | PGLite limitation |
| Hosting | Supabase, self-hosted, Docker | Local file | |
| Migration methods | runMigration, getChunksWithEmbeddings | Same | Added v0.7 |

## Future engine ideas

**TursoEngine.** libSQL（SQLite fork），带 embedded replicas 和 HTTP edge access。可以在保留 SQLite 简单性的同时获得 cloud sync。适合 mobile/edge 场景。

**DuckDBEngine.** 分析型工作负载。批量导出、embedding 分析、brain-wide 统计。不适合 OLTP。可以作为 Postgres 操作引擎旁边的二级分析 engine。

**Custom/Remote.** 接口足够清晰，任何人都可以构建由任意存储支撑的 engine：Firestore、DynamoDB、REST API，甚至平面文件系统。接口不假设 SQL。

Note: 原始 SQLite engine 计划（`docs/SQLITE_ENGINE.md`）已被 PGLite 取代。PGLite 使用与 Postgres 相同的 SQL，消除了为了 FTS5/sqlite-vss 翻译而维护独立 SQLite 方言的需要。
