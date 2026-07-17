# Eval capture — NDJSON schema reference

**Status:** 自 v0.21.0 起稳定。每一行都通过 `schema_version` 做 schema versioning；additive changes 增加 minor version；移除字段属于 breaking-schema-v2。

**Audience:** 下游消费者（主要是 sibling [voltmind-evals](https://github.com/garrytan/voltmind-evals) repo），它们会把捕获到的真实查询作为 BrainBench-Real fixture 回放。

## The pipeline

```
MCP / CLI / subagent tool-bridge caller
     │
     ▼
src/core/operations.ts — query + search op handlers
     │
     │ (hybridSearch or searchKeyword)
     │
     ▼
{results, meta: HybridSearchMeta}                 ┌── captureEvalCandidate
     │                                             │    (fire-and-forget)
     ▼                                             │
return to caller                                   ▼
                                            scrubPii(query) ←── src/core/eval-capture-scrub.ts
                                                   │
                                                   ▼
                                           buildEvalCandidateInput
                                                   │
                                                   ▼
                                           engine.logEvalCandidate
                                                   │
                                    ┌──────────────┴──────────────┐
                                    │ success                     │ fail
                                    ▼                             ▼
                                INSERT into eval_candidates    engine.logEvalCaptureFailure
                                                                 (reason: db_down | rls_reject |
                                                                  check_violation |
                                                                  scrubber_exception | other)
```

## `voltmind eval export` — consumer contract

```sh
voltmind eval export [--since DUR] [--limit N] [--tool query|search]
```

向 **stdout** 输出 NDJSON。每个 JSON object 占一行，并以 `\n` 结束。stderr 接收进度 heartbeat。每行都以 `"schema_version": 1` 开始，因此 forward-compat parser 可以在 schema v2 时大声失败，而不是静默误解析。

voltmind-evals 的典型用法：

```sh
# Snapshot the last week of real traffic for replay
voltmind eval export --since 7d > brainbench-real.ndjson
```

```sh
# Stream through jq for ad-hoc analysis
voltmind eval export --tool query | jq -c 'select(.latency_ms > 500)'
```

## Row schema（v1）

每个导出行都具有以下形状。JSON 输出中的字段顺序不保证；消费者必须按名称取字段，而不是按位置。

| Field | Type | Notes |
|---|---|---|
| `schema_version` | number | v1 行始终为 `1`。Forward-compat gate。 |
| `id` | number | Autoincrement primary key。跨导出稳定。 |
| `tool_name` | `"query"` \| `"search"` | 捕获该行的 MCP operation。 |
| `query` | string | 除非 `eval.scrub_pii: false`，否则已由 `scrubPii` **脱敏 PII**。Emails / phones / SSN / Luhn-verified credit cards / JWTs / bearer tokens 会替换为 `[REDACTED]`。最大长度 50KB（CHECK enforced）。 |
| `retrieved_slugs` | string[] | `SearchResult[]` 返回的去重 slugs。 |
| `retrieved_chunk_ids` | number[] | 按结果顺序列出的每个 chunk id（保留重复，每个 hit 一个）。 |
| `source_ids` | string[] | 结果集中的 distinct `sources.id` 值（v0.18 multi-source）。缺少该列的 pre-v0.18 行为空。 |
| `expand_enabled` | boolean \| null | caller 是否**请求** Haiku expansion。`search` 为 `null`（无 expansion 概念）。 |
| `detail` | `"low"` \| `"medium"` \| `"high"` \| null | caller **请求**的 detail level。省略时为 `null`。 |
| `detail_resolved` | `"low"` \| `"medium"` \| `"high"` \| null | auto-detect 后 `hybridSearch` **实际使用**的值。caller 和 heuristic 都未分类时为 `null`。 |
| `vector_enabled` | boolean | vector search 实际运行时为 true。缺失 `OPENAI_API_KEY` 或 embed 调用失败时为 `false`。**Replay 必须尊重此字段**，`false` 行只覆盖 keyword path。 |
| `expansion_applied` | boolean | Haiku expansion 实际产生 variants 时为 true（不只是“被请求”）。 |
| `latency_ms` | number | op handler 的 wall-clock duration（包含 capture 自身；因为 fire-and-forget，开销可忽略）。 |
| `remote` | boolean | MCP callers（不可信）为 `true`，local CLI 为 `false`。用于区分“真实 agent traffic”和“operator probing”。 |
| `job_id` | number \| null | caller 是 subagent tool-bridge 时的 `OperationContext.jobId`。MCP + CLI 为 null。 |
| `subagent_id` | number \| null | subagent-owned runs 的 `OperationContext.subagentId`。 |
| `created_at` | string (ISO 8601) | 插入时的 UTC timestamp。 |

## Ordering + determinism

`listEvalCandidates` 按 `created_at DESC, id DESC` 排序。同一毫秒插入会在 `created_at` 上打平；`id DESC` 是稳定 tiebreaker。Replay tools 可以按顺序消费，并假设：
- 使用不重叠的 `--since` windows 时不会出现重复行
- 链接 `--since` windows 时不会漏行（run 1 的 window end 是严格 upper bound，不是 soft cursor）

## Schema versioning promise

- **v1（v0.21.0 发布）** — 即本文档。包含上面列出的所有字段。
- **Additive changes** 会增加 voltmind minor version（v0.25.0、v0.23.0 等），并带上新的 optional fields。按已知字段取值的消费者会忽略未知 keys 并继续工作。
- **Breaking changes**（rename、type change、removal）会把 `schema_version` 增到 2。消费者必须按 `schema_version` 分支，才能保持兼容。

## `eval_capture_failures` — companion audit table

不由 `voltmind eval export` 导出。通过 `voltmind doctor` 暴露：

```sh
voltmind doctor   # warns when failures in last 24h > 0
```

Reason enum（稳定）：`db_down` | `rls_reject` | `check_violation` | `scrubber_exception` | `other`。跨进程可见性是重点：`voltmind doctor` 在自己的进程里直接读取该表，因此 in-process counters 不可行。

## Config + CONTRIBUTOR_MODE

自 v0.25.0 起 capture **默认关闭**（早期 drafts 对所有人开启）。有两条开启路径：

**Path A — env var（contributor opt-in，常见情况）：**

```bash
export VOLTMIND_CONTRIBUTOR_MODE=1     # in ~/.zshrc or ~/.bashrc
```

**Path B — 显式配置（`~/.voltmind/config.json`，仅 file-plane）：**

```json
{
  "engine": "postgres",
  "database_url": "...",
  "eval": {
    "capture": true,
    "scrub_pii": true
  }
}
```

解析顺序（越显式越优先）：

1. config 中 `eval.capture: true` → on
2. config 中 `eval.capture: false` → off（覆盖 CONTRIBUTOR_MODE=1）
3. `VOLTMIND_CONTRIBUTOR_MODE === '1'` → on
4. 否则 → off

`scrub_pii` 默认 `true`，独立于 capture。只有在你控制 brain 的分发范围时，才设置 `eval.scrub_pii: false` 来保留原始 query text。

`voltmind config set eval.capture false` **不起作用**：该命令写入 DB-plane config，而 MCP server 读取 file-plane。请直接编辑 JSON 或使用 env var。
