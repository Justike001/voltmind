# VoltMind Infrastructure Layer

所有 skills、recipes 和 integrations 构建其上的共享基础。

## Data Pipeline

```
INPUT (markdown files, git repo)
  ↓
FILE RESOLUTION (local → .redirect → .supabase → error)
  ↓
MARKDOWN PARSER (gray-matter frontmatter + body)
  → compiled_truth + timeline separation
  ↓
CONTENT HASH (SHA-256 idempotency check — skip if unchanged)
  ↓
CHUNKING (3 strategies, configurable)
  ├── Recursive: 300-word chunks, 50-word overlap, 5-level delimiter hierarchy
  ├── Semantic: embed sentences, cosine similarity, Savitzky-Golay smoothing
  └── LLM-guided: Claude Haiku identifies topic shifts in 128-word candidates
  ↓
EMBEDDING (OpenAI text-embedding-3-large, 1536 dimensions)
  → batch 100, exponential backoff, non-fatal if fails
  ↓
DATABASE TRANSACTION (atomic: page + chunks + tags + version)
  ↓
SEARCH (hybrid, available immediately)
```

## Search Architecture

VoltMind 使用 Reciprocal Rank Fusion (RRF) 合并向量搜索和关键词搜索：

```
User Query
  ↓
EXPANSION (optional: Claude Haiku generates 2 alternative phrasings)
  ↓
  ├── VECTOR SEARCH (pgvector HNSW, cosine distance)
  │     → 2x limit results per query variant
  │
  └── KEYWORD SEARCH (PostgreSQL tsvector, ts_rank)
        → 2x limit results
  ↓
RRF MERGE (score = Σ(1/(60 + rank)), balances both fairly)
  ↓
4-LAYER DEDUP
  ├── Best 3 chunks per page (source dedup)
  ├── Jaccard similarity > 0.85 (text dedup)
  ├── No type exceeds 60% (diversity)
  └── Max 2 chunks per page (page cap)
  ↓
TOP N RESULTS (default 20)
```

## Key Components

| File | Purpose |
|------|---------|
| `src/core/engine.ts` | 可插拔 engine 接口（BrainEngine） |
| `src/core/postgres-engine.ts` | Postgres + pgvector 实现 |
| `src/core/import-file.ts` | importFromFile + importFromContent 流水线 |
| `src/core/sync.ts` | 基于 Git 的增量变更检测 |
| `src/core/markdown.ts` | YAML frontmatter + compiled_truth/timeline 解析 |
| `src/core/embedding.ts` | OpenAI embedding，带 batch、retry、backoff |
| `src/core/chunkers/recursive.ts` | 基础 chunker（300w、5 层 delimiter） |
| `src/core/chunkers/semantic.ts` | 基于 embedding 的主题边界检测 |
| `src/core/chunkers/llm.ts` | Claude Haiku 引导的 chunking |
| `src/core/search/hybrid.ts` | 向量 + 关键词的 RRF merge |
| `src/core/search/dedup.ts` | 4 层结果去重 |
| `src/core/search/expansion.ts` | 通过 Claude Haiku 做多查询扩展 |
| `src/core/storage.ts` | 可插拔 storage（S3、Supabase、local） |
| `src/core/operations.ts` | Contract-first operation 定义（31 ops） |
| `src/schema.sql` | 完整 DDL（10 张表、RLS、tsvector、HNSW） |

## Schema Overview

Postgres 中有 10 张表：

- **pages** — slug（唯一）、type、title、compiled_truth、timeline、frontmatter（JSONB）
- **content_chunks** — pgvector 1536 维 embedding、chunk_source（compiled_truth|timeline）
- **links** — typed edges（knows、works_at、invested_in、founded 等）
- **tags** — 多对多页面标签
- **timeline_entries** — 结构化事件（date、source、summary、detail）
- **page_versions** — 用于 diff/revert 的快照历史
- **raw_data** — 来自外部 API 的 sidecar JSON（保留 provenance）
- **files** — storage backend 中的二进制附件
- **ingest_log** — import 操作审计轨迹
- **config** — brain 级设置（version、embedding model、chunk strategy）

全文搜索使用加权 tsvector：title（A）、compiled_truth（B）、timeline（C）。
向量搜索在 content_chunks.embedding 上使用带 cosine distance 的 HNSW 索引。

## The Thin Harness Principle

VoltMind 是确定性层。Skills 和 recipes 是 latent space 层。

完整架构哲学见 [Thin Harness, Fat Skills](../ethos/THIN_HARNESS_FAT_SKILLS.md)。

- **VoltMind CLI** = thin harness（相同输入 → 相同输出）
- **Skills**（ingest、query、maintain、enrich、briefing、migrate、setup）= fat skills
- **Recipes**（voice-to-brain、email-to-brain）= 会安装基础设施的 fat skills

agent 会读取 skill/recipe，并使用 VoltMind 的确定性工具完成工作。
