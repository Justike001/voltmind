# Code Cathedral II — v0.20.0 设计

**状态：** Accepted。CEO + Eng + 2 次 codex pass 已 CLEARED（2026-04-24）。总计吸收 16 条 cross-model finding：7 条 codex pass 1（structural prereqs）+ 6 条 codex pass 2（absorption errors，包括 CHUNKER_VERSION silent-no-op gate 和 inbound-edge invalidation）+ 3 条 eng-review 架构决策。DX review 建议在 ship 前、Layer 8 之后（新 CLI surfaces）进行。
**Supersedes：** Cathedral I（计划 v0.18.0–v0.19.0 code indexing，已在 v0.19.0 ship）。
**Mode：** SCOPE EXPANSION（用户明确：“I want the best code search in the world”）。
**Scale：** 14 个可 bisect layer，约 20–25 CC hours，3–5 human-weeks。一次 schema migration，拆分 edge tables（`code_edges_chunk` + `code_edges_symbol`）。通过 `CHUNKER_VERSION` bump 自动 backfill（下次 sync）+ 显式 `voltmind reindex-code` 命令。

## 为什么是 v0.20.0

v0.19.0 已发布 code indexing：tree-sitter chunker、29 种 active languages、symbol columns、forward doc↔impl linking、incremental embed cache、BrainBench code category。Cathedral I 在 ship 时推迟了四项：`query --lang` filter、`sync --all` cost preview、markdown fence extraction、reverse-scan doc↔impl backfill。

Cathedral II 是兑现这四个承诺的 release，并打包一次跃迁，让 voltmind 成为真正的 code search：structural edges（call graph + references + imports + inheritance）、parent-scope capture、doc-comment FTS binding、two-pass retrieval。不再是 grep-class code retrieval。

## 10x leap

今天：agent 问 “how does hybrid search handle N+1?” → 得到 `hybrid.ts` 的 3 个 prose chunks。

Cathedral II：同一个 query 返回 anchor function + 它的 3 个 callers + 2 个 callees + 它的 JSDoc + `/docs` 中引用它的 guide + 覆盖它的 test file + parent scope chain。一次 walk。Code-aware brain。

## Scope（5 tiers + Layer 0 prerequisites，14 个可 bisect layer commits）

### Tier 0 — Prerequisites（由 codex outside voice 浮现）

**0a. File-classification widening。** `sync.ts:35` 目前只把 9 种扩展名分类为 code（TS、JS、Python、Go、Rust、Ruby、Java、C、C++）。Cathedral II 的 B1 会 ship 165 个 lazy-loadable grammars，因此 classifier 需要接受 chunker 可处理的任何扩展名。同时重排 `detectCodeLanguage`，让 Magika（B2）作为 extension-less files 的 fallback 运行，而不是排在 null-return gate 后面。

**0b. Chunk-grain FTS。** 当前 keyword search 位于 `pages.search_vector`。如果还是 page-grain primitive，那么在 chunk 级别添加 doc-comments 或 two-pass anchoring 对 ranking 没有影响。Layer 0b 添加 `content_chunks.search_vector`，trigger 从 qualified symbol name + doc-comment（weight A）和 chunk_text（weight B）构建；并重写 `searchKeyword`，直接对 chunks 排名。Page-level search_vector 继续服务 title-heavy searches。

这两个 Layer 0 项是让 10x leap 真正改变 retrieval metrics 的前置条件。

### Tier A — Structural edges（10x leap）

**A1. Call-graph + reference extraction with qualified symbol identity。** 在 `importCodeFile` 时，per-language tree-sitter queries 捕获：

- `calls` — function call-sites
- `imports` — module deps
- `extends` / `implements` — type hierarchies
- `mixes_in` — Ruby `include`/`extend`/`prepend`
- `type_refs` — parameter + return type usage
- `declares` — chunk owns a symbol definition

**Qualified symbol identity across all 8 langs。** `parent_symbol_path` 是 scope 的 source of truth；edges 使用由它构建的 qualified names。示例：`Admin::UsersController#render`（Ruby instance）、`Admin::UsersController.find_all`（Ruby singleton）、`admin.users_controller.UsersController.render`（Python）、`(*UsersController).Render`（Go）、`users::UsersController::render`（Rust）、`com.acme.admin.UsersController.render`（Java）。每种语言都有 delimiter + method/class-method distinction。Ruby 在 ranker 中完整 ship（CLI + A2 two-pass），不延期。

**拆分 schema（两个表，而不是一个 polymorphic 表）：**
```sql
CREATE TABLE code_edges_chunk (
  from_chunk_id INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  to_chunk_id   INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  from_symbol_qualified TEXT NOT NULL,
  to_symbol_qualified   TEXT NOT NULL,
  edge_type     TEXT NOT NULL,
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  UNIQUE (from_chunk_id, to_chunk_id, edge_type)
);
CREATE TABLE code_edges_symbol (
  from_chunk_id INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  from_symbol_qualified TEXT NOT NULL,
  to_symbol_qualified   TEXT NOT NULL,
  edge_type     TEXT NOT NULL,
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  UNIQUE (from_chunk_id, to_symbol_qualified, edge_type)
);
```
`code_edges_chunk` = resolved（两个 endpoint 都已知）。`code_edges_symbol` = unresolved（目标 symbol 只有 qualified name，定义 chunk 尚未见到）。后续 import 时将 symbol→chunk table 中的边 promotion。`source_id` 是 TEXT，与实际 `sources.id` 类型一致。

**Shipped languages：** TypeScript、TSX、JavaScript、Ruby、Python、Go、Rust、Java（8 种，覆盖真实 brain code 的约 85%）。其他语言仍正常 chunk（通过 B1 lazy-load），但 v0.20.0 不发 edges；扩展只需要一个 query file + 每语言 delimiter config，适合作为小 follow-up PR。

**A2. Two-pass retrieval。** 当前：keyword + vector → RRF → dedup。新流程：keyword + vector → anchor set → 在 `code_edges_chunk` 上扩展 1–2 hops，带 structural-distance decay → 混入 RRF。

**所有情况下默认 OFF。** 只通过 `--walk-depth N` 或 `--near-symbol <name>` opt-in。Exact-symbol-match auto-on 不安全（symbol name 会跨文件冲突）。Neighbor cap 50 per hop，depth cap 2。Walking 时 dedup 的 per-page cap（当前 2）提升到 `min(10, walkDepth × 5)`，避免同一文件中的 structural neighbors 被裁掉。Distance decay：expanded-neighbor RRF contribution 使用 `1/(1 + hop)`。

**A3. Parent-scope capture + nested-chunk emission。** 两部分：

*Part 1:* Nested symbols 在 `content_chunks` 上获得 `parent_symbol_path text[]`。它会嵌入 chunk header：`[TypeScript] src/foo.ts:42-58 function formatResult (in BrainEngine.searchKeyword)`。Scope 流入 embedding。双用途：驱动 A1 的 qualified symbol identity。

*Part 2:* 扩展 `splitLargeNode`，把 nested functions/methods/inner-classes 作为独立 chunks 发出。当前 chunker 面向 top-level node：`class Foo { method1() {} method2() {} }` 只产生一个 chunk。Top-level node 的 parent_symbol_path 为空（其上没有 parent），所以如果没有 sub-top-level chunks，A3 没有承重价值。Part 2 让 scope annotation 真正 load-bearing。

**A4. Doc-comment → symbol binding。** Leading AST comment 提取到 `doc_comment text`。落在 **chunk-grain** search_vector（Layer 0b prereq）上，FTS weight 为 `'A'`。Natural-language queries 中，docstring matches 排在 body text 之上、title 之下。按 Postgres FTS weight convention，`'A' > 'B' > 'C' > 'D'`。

### Tier B — Coverage（诚实的 Chonkie parity）

**B1.** Lazy-load tree-sitter-language-pack（约 165 种语言）。用 manifest + per-process parser cache 替换 36 个 committed WASMs。Cathedral I 承诺了这件事但没交付，Cathedral II 交付。

**B2.** Magika auto-detect for extension-less files（Dockerfile、Makefile、`.envrc`）。约 1MB bundled asset。如果 classifier 加载失败，fallback 到 null → recursive chunker。

### Tier C — Agent CLI surfaces

- `query --lang <lang>` — 按 `content_chunks.language` filter
- `query --symbol-kind function|class|method|type|interface|enum` — 按 `symbol_type` filter
- `query --near-symbol <name> --depth 1..2` — anchor 在已知 symbol 上的 two-pass retrieval
- `code-callers <symbol>` — 使用 A1 `calls` edges，反向
- `code-callees <symbol>` — 使用 A1 `calls` edges，正向

非 TTY 自动 JSON。失败时使用 `StructuredAgentError` envelope。`code-signature` 推迟到 v0.20.1（需要 per-language type captures）。

### Tier D — Bridge items（cathedral I 承诺）

**D1.** `sync --all` cost preview。`estimateTokens` 从 `chunkers/code.ts` 抽到新的 `tokens.ts` module。Per-source loop 前：walk sync-diff set、sum tokens、计算 $ estimate。TTY + !json + !yes → interactive `[y/N]`。Non-TTY 或 `--json` 或 piped → emit `ConfirmationRequired` envelope，exit 2。`--yes` 跳过。`--dry-run` preview + exit 0。仅在 `--all` 上 preview，不在 single-source 上（DX review 的痛点是首次 large-sync 的 surprise bills）。

**D2.** Markdown fence extraction in `importFromContent`。`parseMarkdown` 后遍历 marked lexer tokens 中的 `{type:'code', lang, text}`。把 fence tag 映射到 language。每个 fence 通过 `chunkCodeText` chunk。以 `chunk_source='fenced_code'` 持久化。每个 markdown page 限 100 个 fences（DOS defense）。每个 fence try/catch，一个坏 fence 不破坏整页 import。

**D3.** `reconcile-links` batch command。遍历 markdown pages，对每页调用现有 v0.19.0 `extractCodeRefs`，emit `addLink(md, code, ..., 'documents')` + reverse。`ON CONFLICT DO NOTHING` 处理幂等。Statement-timeout 通过 `sql.begin` + `SET LOCAL` 作用域化。Progress reporter + final summary（edges added / existed / missing-target）。遵守 `auto_link` config。

### Tier E — Eval, backfill, honesty

**E1.** BrainBench code sub-categories：`call_graph_recall`（X 的 callers → expected set）、`parent_scope_coverage`（nested-symbol queries 返回正确 scope）、`doc_comment_matching`（NL queries 中 doc-comments 排在 prose 之上）。Regression gates 防止 A1/A3/A4 drift。

**E2.** Backfill：schema 自动迁移（零成本）。**`CHUNKER_VERSION` 从 3 bump 到 4** ——该常量折入每个 code page 的 `content_hash`，所以升级后每个 code page 的 hash 都会变化。下次 `voltmind sync` 不会因为“git HEAD unchanged”短路；它会重新 chunk 每个 code file。新的 `voltmind reindex-code [--source <id>] [--dry-run] [--yes] [--force]` 提供显式 full backfill，带 cost preview（复用 D1 infra），并且 `--force` 完全绕过 content_hash skip。用户控制何时付费；silent no-op path 被关闭。

**E3.** Honest CHANGELOG。退役 “Chonkie superset” framing。Ship 前后运行 BrainBench 获得真实数字：150+ languages loaded（B1 后）、NL→code queries 的 MRR、call-graph precision P@1、symbol_name queries 的 P@k、5K-file repo 上的 sync cost preview。每个 claim 都有可运行命令背书。

## Implementation ordering（14 layers，post-codex）

1. **0a** — File-classification widening（`sync.ts:35`）+ Magika reordered as fallback
2. **0b** — Chunk-grain FTS（`content_chunks.search_vector` + trigger + searchKeyword chunk-level rewrite）
3. **Foundation** — schema migration（split edge tables、qualified name columns on content_chunks）+ engine method stubs + types
4. **B1** — lazy-load grammar manifest + bun --compile guard
5. **A1** — edge-extractor + 8 per-lang query files + qualified symbol identity + tests
6. **A3** — parent-scope column + doc-comment column + splitLargeNode nested-chunk emission
7. **A4** — doc-comment FTS weight A on chunk-grain search_vector
8. **A2** — two-pass retrieval，默认 OFF，仅 opt-in；walking 时 dedup cap 提升
9. **D tier bundled** — cost preview + fence extraction + reconcile-links
10. **B2** — Magika auto-detect
11. **C tier** — 5 个 CLI surfaces
12. **E1** — BrainBench sub-categories + CHUNKER_VERSION 3→4 bump
13. **E2** — `reindex-code` with `--force` + migration orchestrator with backfill-prompt phase
14. **E3 + release** — honest CHANGELOG + docs + migration skill + `/ship`

## Size and cost

- Diff：约 5500–6500 行（约为 v0.19.0 post-codex expansion 的 2.5x）
- Tests：约 2000 行（8 langs × qualified-name + edge-extraction fixtures + Layer 0b FTS migration tests）
- Files：约 36 new，约 25 modified
- CC time：约 20–25 小时 focused（pre-codex 为 14–18；因 Layer 0a/0b + 8 langs qualified identity + nested-chunk emission + CHUNKER_VERSION bump layer 增加 6h）
- Human-equivalent：3–5 周
- 升级 v0.19.0 用户的 first-sync cost bump：升级后首次 sync 会重新 chunk 每个 code page（CHUNKER_VERSION bump 强制 invalidation）。用户可运行 `voltmind reindex-code --dry-run` 预估成本，然后 `--yes`，或让文件随时间变化时逐步 backfill。
- Backfill 后 daily autopilot cost：不变（edges 在 chunk time 提取，query 时没有 per-query LLM）

## Risks and mitigations

1. **Live Postgres 上的 schema migration。** Ship 前对 production-shape DB 测试。v0.12.0 JSONB incident 是 canary。
2. **Per-language tree-sitter queries 很 fiddly。** 每种语言都有手工验证的 edge-set fixtures。Ruby 对 dynamic-dispatch false negatives 额外覆盖。
3. **Two-pass retrieval regression。** Prose 默认关闭。Ship 前 BrainBench Cat 1 必须无 regression。
4. **Backfill shape（G1 resolved）。** 三个可组合 layer：schema-auto 迁移空列（零成本）。Lazy on-touch 随时间捕获 80%（零成本）。显式 `reindex-code` 带 cost preview，供想立即获得完整收益的用户使用。没有 surprise bills。
5. **Magika bundle（G2 resolved）。** +1MB asset，`bun --compile` guard extension。如果实现后期暴露 bundling bug，B2 是唯一可回退到 v0.20.1 而不阻塞 cathedral 的 tier；它是自包含的 Layer 8。
6. **High-fan-out symbols。** `console.log` 式 symbol 可能有 100K callers。Neighbor cap 50，depth cap 2。需要 chaos test fixture。

## Review gates

- CEO review（cathedral II）— CLEARED 2026-04-24
- Outside voice（codex）— 在 cathedral II CEO review 期间运行
- `/plan-devex-review` — 接下来（按用户请求，5 个新 CLI surfaces + reindex-code 需要 DX polish review 后再 eng）
- `/plan-eng-review` — 实现开始前必需
- `/review` + `/codex review` — `/ship` 前必需

## What’s deferred to later cathedrals

- **C6** `code-signature "(A, B) => C"` — per-language type captures。v0.20.1。
- **Call-graph langs beyond 8 shipped** — PHP、Swift、Kotlin、Scala、C#、C++、Elixir 等。每种语言一个小 PR。
- **LSP integration** for live precision。v0.22+ cathedral。
- **Code-tour generator**（cathedral I T1）。
- **Private-code redaction pre-embed**（cathedral I T3）。
- **`voltmind doctor --chunker-debug`** AST dump。
