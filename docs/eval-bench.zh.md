# 针对你的 voltmind changes 运行真实世界 eval benchmarks

Audience：voltmind maintainers 和 contributors。如果你在改 retrieval（search、ranking、embeddings、intent classification、query expansion、source boost、hybrid fusion），这就是要读的文档。

关于 voltmind-evals 消费的 **NDJSON wire format**，见 [`eval-capture.md`](./eval-capture.md)。本文描述的是建立在该格式之上的人类 dev loop。

## Prerequisite：打开 contributor mode

生产用户默认**关闭** capture（隐私友好，不会意外积累数据）。Contributors 用一行打开：

```bash
# In ~/.zshrc or ~/.bashrc:
export VOLTMIND_CONTRIBUTOR_MODE=1
```

验证：

```bash
voltmind query "anything" >/dev/null
psql $DATABASE_URL -c 'SELECT count(*) FROM eval_candidates'   # should be > 0
```

如需覆盖（无论 env var 如何都强制 on/off），编辑 `~/.voltmind/config.json`：

```json
{"eval": {"capture": true}}    // force on
{"eval": {"capture": false}}   // force off
```

显式 config 在两个方向上都优先于 env var。

## The 4-command loop

```bash
# ① Capture: writes to eval_candidates whenever CONTRIBUTOR_MODE is set.
#   Inspect what's been collected:
voltmind doctor                                     # surfaces capture failures
psql $DATABASE_URL -c 'SELECT count(*) FROM eval_candidates'

# ② Snapshot: freeze a baseline before your code change.
voltmind eval export --since 7d > baseline.ndjson

# ③ Code change: do whatever you want — tune RRF_K, swap embed model, edit
#    hybrid.ts, add a new boost source, change the intent classifier.

# ④ Replay: re-run every captured query against the current build.
voltmind eval replay --against baseline.ndjson
```

输出：

```
Replaying 247 captured queries…
  ...25/247
  ...50/247
  ...
Replayed 247 of 247 captured queries (0 skipped, 0 errored)
Mean Jaccard@k:    0.927
Top-1 stability:   91.5%
Mean latency Δ:    +14ms (current vs captured)

Top 5 regression(s):
  jaccard=0.20  captured=12  current=3   "find every reference to widget-co"
  jaccard=0.43  captured=14  current=8   "show me everything tagged for review"
  jaccard=0.50  captured=8   current=4   "what did alice say about the spec"
  ...
```

三个数字告诉你 change 是否适合落地：

| Metric | What it means | Healthy range |
|---|---|---|
| **Mean Jaccard@k** | captured retrieved slugs 与 current run slugs 的平均重叠度。1.0 = 集合完全相同。 | “neutral” changes 应 ≥0.85。<0.7 表示 retrieval 大幅偏移。 |
| **Top-1 stability** | #1 结果未变化的 queries 比例。 | tuning passes 应 ≥85%。<70% 表示 top-of-funnel 出问题。 |
| **Mean latency Δ** | current minus captured。正数 = 当前更慢。 | 与 captured 相差 ±50ms 内。任何地方 >2× 都是 regression alarm。 |

## 它实际做什么

`voltmind eval replay` 读取 NDJSON snapshot，并对每一行：

1. 用捕获的 `detail` 和 `expand_enabled` 值重新执行相同 op（`tool_name='search'` 用 `searchKeyword`，`tool_name='query'` 用 `hybridSearch`）。
2. 捕获当前 `retrieved_slugs`（去重，按结果顺序）。
3. 计算 captured 与 current slug sets 的 set-Jaccard。
4. 记录 top-1 是否匹配（#1 结果是否同一 slug）。
5. 记录相对 captured `latency_ms` 的 latency delta。

它不计算 MRR 或 nDCG，因为这些需要 ground-truth relevance labels，而不是 baseline comparison。要做 metric-against-truth eval，请使用 `voltmind eval --qrels <path>`（legacy IR-eval path，仍支持）。Replay tool 回答的是另一个问题：“我的代码改动是否移动了 retrieval，移动最大的 queries 是哪些？”

第三条评估轴是 public benchmark、ground-truth labels、完整 question-answer pipeline（不只是 retrieval）：`voltmind eval longmemeval <dataset.jsonl>`（v0.28.8）会用 voltmind hybrid retrieval 跑 LongMemEval benchmark。每个问题得到一个干净的 in-memory PGLite，导入 haystack，提出问题，并以 JSONL 输出 hypothesis，正好符合 LongMemEval 的 `evaluate_qa.py`。你的 `~/.voltmind` brain 从不打开。见下方 `## Public benchmarks: LongMemEval`。

## Best-effort by design

Replay 不是纯函数。Capture 与 replay 之间可能漂移三件事：

1. **Brain state** — 你的 brain 可能比 snapshot 时多了 pages。除非显式 seed 固定语料，否则新 pages 进入候选会让 mean Jaccard 下降。
2. **Embedding source** — 如果 capture 和 replay 之间更换了 `OPENAI_API_KEY`（或 embedding model 轮换），vector-path results 会漂移，即使代码相同。
3. **Capture cap** — captured `retrieved_slugs` 是去重集合，不保留内部 ranking metadata。两个 tools 可以返回同一 slug set 但分数不同，Jaccard 会说 1.0，但按 score 排序的 downstream consumer 可能表现不同。

这些 metrics 是**真实 queries 上的 regression alarms**，不是 hash check。请配合手动检查 top regressions。

## Cost

snapshot 中每个 `query` row 都会通过 OpenAI embed query string，以运行 `hybridSearch` 的 vector half。成本等同于一次普通 `voltmind query` 调用：按 OpenAI list price 的 text-embedding-3-large，在单个 replay row 内 batched。

本地迭代时如果不想每次改动都付费，用 `--limit 50` 限制 replay rows。最近 50 行通常足够判断方向；最终 pre-merge run 再扩展。

```bash
# Iteration mode — 50 most recent queries
voltmind eval replay --against baseline.ndjson --limit 50

# Pre-merge — full snapshot
voltmind eval replay --against baseline.ndjson --top-regressions 20
```

## CI integration

```bash
voltmind eval replay --against baseline.ndjson --json > replay.json
jq -e '.summary.mean_jaccard >= 0.85' replay.json || exit 1
jq -e '.summary.top1_stability_rate >= 0.85' replay.json || exit 1
```

稳定 JSON shape（schema_version: 1）：

```json
{
  "schema_version": 1,
  "summary": {
    "rows_total": 247,
    "rows_replayed": 247,
    "rows_skipped": 0,
    "rows_errored": 0,
    "mean_jaccard": 0.927,
    "top1_stability_rate": 0.915,
    "mean_latency_delta_ms": 14,
    "rows_over_2x_latency": 0
  }
}
```

`--verbose` 会添加 `results: [...]` 数组，每个 replayed row 一个 entry（适合 pipe 到 jq 或 notebook 做深入分析）。

## When to run this

合并任何触碰以下内容的改动前运行：

- `src/core/search/hybrid.ts`（RRF、fusion、dedup、two-pass retrieval）
- `src/core/search/source-boost.ts` / `sql-ranking.ts`（per-source ranking）
- `src/core/search/intent.ts`（auto-detail classification）
- `src/core/search/expansion.ts`（Haiku query expansion）
- `src/core/search/dedup.ts`（cross-page result collapse）
- `src/core/embedding.ts` 或任何 embedding model swap
- `src/core/operations.ts` `query` 或 `search` op handlers（capture surface）
- `src/core/postgres-engine.ts` / `pglite-engine.ts` 的 `searchKeyword` / `searchVector` SQL

可跳过：schema-only migrations、doc changes、tests-only PRs，以及不触碰 retrieval 的 CLI ergonomics。

## Building your own corpus

如果还没有 captured traffic（fresh install，无法在合并前 dogfood 一周），可以手写 NDJSON：

```jsonl
{"schema_version":1,"id":1,"tool_name":"query","query":"who is alice","retrieved_slugs":["people/alice","people/alice-bio"],"expand_enabled":false,"detail":null,"latency_ms":0,"remote":false}
{"schema_version":1,"id":2,"tool_name":"search","query":"acme deal","retrieved_slugs":["deals/acme-seed","companies/acme"],"latency_ms":0,"remote":false}
```

然后运行 `voltmind eval replay --against handcrafted.ndjson` 确认 authoritative slugs 能返回。这是 BrainBench-Real pipeline（针对 live captures replay）与 BrainBench fixed-fixture pipeline（用 sibling [voltmind-evals](https://github.com/garrytan/voltmind-evals) corpus 执行 `voltmind eval --qrels`）之间的连接点。

## Off-switch

两种方式关闭 capture：

```bash
unset VOLTMIND_CONTRIBUTOR_MODE             # easy: just unset the env var
```

或通过 `~/.voltmind/config.json` 强制关闭（无论 env var 如何）：

```json
{"eval": {"capture": false}}
```

已有 `eval_candidates` rows 会保留，直到你运行 `voltmind eval prune --older-than 0d`（或直接 drop table）。

## Failure modes

| What you see | What it means |
|---|---|
| `Mean Jaccard@k: 0.4`, top regressions all in one source dir | 该 prefix 上的 source boost 或 hard-exclude regression |
| `Top-1 stability: 30%`, mean Jaccard still high | RRF tuning 改变了 rank order 但未改变集合，需要重新调 `rrfK` |
| `Mean latency Δ: +500ms`, jaccard high | Vector path 变慢；检查 embedding API 或 HNSW probes |
| `rows_errored > 0` | 一个或多个 queries 抛错。查看 human output 的前 3 个，或用 `--json` 查看所有 `error_message` fields |
| Many `skipped: empty query` | Capture 记录了有人传空 `query` 的 rows；检查为何会被 capture |

## Public benchmarks: LongMemEval（v0.28.8）

`voltmind eval longmemeval` 会直接用 voltmind hybrid retrieval 跑 public [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval) benchmark。它与 `eval replay` 是不同评估轴：public dataset with ground-truth labels、end-to-end question-answer pipeline、hermetic per-question brains。

```bash
# Download the dataset (visit the HF page in a browser; gated/manual download).
# Place longmemeval_oracle.json (or _s.json) somewhere local.

# Retrieval-only (no LLM answer-gen, fastest path, no Anthropic key needed):
voltmind eval longmemeval ./longmemeval_oracle.json --limit 50 --retrieval-only \
  > /tmp/hypothesis.jsonl

# Full pipeline (Anthropic key required for answer-gen):
voltmind eval longmemeval ./longmemeval_oracle.json --limit 50 \
  > /tmp/hypothesis.jsonl

# Score with LongMemEval's published evaluate_qa.py (not bundled — needs
# OpenAI gpt-4o per their spec):
python evaluate_qa.py /tmp/hypothesis.jsonl
```

### Architecture（如果你在改 harness，请读）

- 每个 benchmark run 通过 `createBenchmarkBrain` + `withBenchmarkBrain` 使用一个 in-memory PGLite。你的 `~/.voltmind` 从不打开。
- 问题之间：对 runtime-enumerated `pg_tables` 执行 `TRUNCATE`，不是 hardcoded list，避免 schema migrations 静默泄漏数据。Infrastructure tables（`sources`, `config`, `voltmind_cycle_locks`, `subagent_rate_leases`）会跨 resets 保留。
- Sanitization parity：复用 `src/core/think/sanitize.ts` 的 `INJECTION_PATTERNS`，因此新增 injection pattern 会自动覆盖 takes 与 benchmarks。一个 source of truth。
- Retrieved chat content 包在 `<chat_session id="..." date="...">` framing 中；answer-gen system prompt 声明该内容 UNTRUSTED。与 `<take>` framing 姿态相同。
- LLM injection seam：`runEvalLongMemEval(args, {client?: ThinkLLMClient})`。Tests stub client，因此完整 pipeline 无需 API key 也能 hermetically run。

### Flags

| Flag | Default | Purpose |
|---|---|---|
| `--limit N` | run all | 限制 question count（快速迭代） |
| `--retrieval-only` | off | 输出 retrieved chunks；不做 LLM answer-gen |
| `--keyword-only` | off | 关闭 vector path（debug retrieval issues） |
| `--expansion` | **off** | Multi-query expansion。默认关闭以保证 determinism（无 per-query Haiku call）。传入该 flag 才开启。 |
| `--top-k K` | 10 | Retrieval depth |
| `--model M` | resolved | 默认通过 `resolveModel()` 6-tier chain（`models.eval.longmemeval` config key）解析 |
| `--output FILE` | stdout | 写 hypothesis JSONL 到文件，而不是 stdout |

### Numbers

Apple Silicon 上 warm reset+import+search 的 p50 25.9ms / p99 30.3ms（来自 `test/eval-longmemeval.test.ts` perf gate）。Per-question cost 远低于 500ms speed gate。500 questions = 约 13s overhead + retrieval 和 LLM latency。

## Measuring brain consistency over time（v0.32.6）

`voltmind eval suspected-contradictions` 是互补测量工具：它抽样检索结果，寻找未标记的语义矛盾（例如 compiled_truth vs chat content、intra-page chunk vs active take）。LongMemEval 衡量固定标注集上的 retrieval correctness，而 contradiction probe 衡量真实 brain 多频繁地暴露冲突答案。

### Recommended nightly cadence

```bash
# Once a day, against your top 50 most-frequent queries:
voltmind eval suspected-contradictions \
  --queries-file ~/.voltmind/queries.jsonl \
  --top-k 5 \
  --budget-usd 5 \
  --output ~/.voltmind/probe-runs/$(date +%Y-%m-%d).json
```

Persistent cache（`eval_contradictions_cache`）让重跑成本近乎为零，直到 bump `PROMPT_VERSION`。通过以下命令做 trend-track：

```bash
voltmind eval suspected-contradictions trend --days 30
```

ASCII bar chart 会显示每天 flagged 总数。Headline % 会出现在 `voltmind doctor` 的 `contradictions` check 中，并为 high-severity findings 提供可粘贴 resolution commands。

### See also

- `docs/contradictions.md` — architecture、severity rubric、action criteria。
- CHANGELOG `## [0.32.6]` — 完整 release notes，包括由 Wilson CI lower-bound gate 控制的 bigger-swing decision criteria。
