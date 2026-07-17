# voltmind eval suspected-contradictions（v0.32.6）

矛盾探针会抽样检索结果，要求一个 LLM 裁判判断是否有任意一对内容在与用户查询相关的事实主张上互相矛盾，并汇总成一份经过校准的报告。输出是数据，真正决定如何处理的是操作者。本文说明它的架构、严重程度标准、如何解读标题数字，以及何时应该采取行动。

## 为什么存在

voltmind 通过 compiled-truth-plus-timeline 和 source-boost 处理*已策展*页面的矛盾：当 `companies/acme.md` 说 MRR 是 $2M，而 2024 年的一段聊天记录说 MRR 是 $50K 时，策展页面会排在聊天记录前面。`takes.active` 过滤会隐藏明确被取代的 take。Recency decay 会按 source-tier 让更新的内容在排序上更有利。

这些机制没有衡量的是：未标记的语义矛盾究竟多频繁地出现在检索结果中？没有探针时，每次决定“要不要做更大的改动（chunk 级 `revises` 字段 + 排名调整）”都只是凭感觉。探针提供证据。

## Architecture

```
        ┌──────────────────────────────────────┐
        │ voltmind eval suspected-contradictions │
        └──────────────────┬───────────────────┘
                           │
        ┌──────────────────▼───────────────────┐
        │ For each query: hybridSearch top-K   │
        │ → cross_slug_chunks + intra_page     │
        │   chunk-vs-take pairs                │
        └──────────────────┬───────────────────┘
                           │
        ┌──────────────────▼───────────────────┐
        │ Date pre-filter: skip pairs whose    │
        │ dates are >30d apart (Codex fix:     │
        │ same-paragraph-dual-date overrides)  │
        └──────────────────┬───────────────────┘
                           │
        ┌──────────────────▼───────────────────┐
        │ Persistent cache lookup              │
        │ (chunk_a_hash, chunk_b_hash, model,  │
        │  prompt_version, truncation_policy)  │
        └────────┬─────────┬────────────────────┘
              hit│         │miss
                 │         ▼
                 │   ┌─────────────────────────┐
                 │   │ LLM judge call          │
                 │   │ → JudgeVerdict          │
                 │   │ confidence floor ≥ 0.7  │
                 │   └─────────┬───────────────┘
                 │             │
                 ▼             ▼
        ┌──────────────────────────────────────┐
        │ Aggregate per-query + global stats   │
        │ Wilson 95% CI on headline %          │
        │ source-tier breakdown                │
        │ hot pages + resolution proposals     │
        └──────────────────┬───────────────────┘
                           │
                           ▼
                  ProbeReport JSON
                           │
        ┌──────────────────┼──────────────────────┬───────────────┐
        ▼                  ▼                      ▼               ▼
   doctor (M1)         MCP (M3)             synthesize (M2)   trend (M5)
   surfaces           find_contradictions    informational     persistent
   findings           op for agents          block in prompt   tracking
```

## 严重程度标准

裁判会为每条发现分配严重程度：

| Level | Rubric | Example |
|---|---|---|
| `low` | 命名/格式差异 | "Alice Smith" vs "A. Smith" |
| `medium` | 可能过时的事实值 | revenue figure, headcount, valuation |
| `high` | 身份/结构性主张 | founder/CEO/CFO role, company status |

Doctor 会按严重程度降序排序发现。MCP op 接受严重程度过滤器，让 agent 只获取高优先级项目。

## 如何解读标题数字

探针输出 `queries_with_contradiction / queries_evaluated`，并附带 Wilson 95% 置信区间：

```
Queries with >=1 contradiction: 12 / 50 (24%)  Wilson CI 95%: 14–37%
```

它的含义是：以 95% 置信度，真实比率位于 14% 到 37% 之间。24% 的点估计是最可能的值，但受抽样噪声约束。**当 n < 30 时会触发 `small_sample_note`**，此时置信区间太宽，不适合据此行动。

关于更大改动（chunk 级 `revises` 字段）的决策标准：

| Wilson CI lower bound | What it says | Action |
|---|---|---|
| < 5% | Source-boost + recency-decay + curated pages 足以承载负载 | 到此为止；当前范围正确 |
| 5–15% | 真实存在但范围有限 | 操作者决定成本是否值得 |
| > 15% | 真实且显著 | 在 v0.34+ 规划更大改动 |

## 何时处理发现

每条发现都带有一个可直接粘贴的 `resolution_command` 字段：

- `voltmind takes supersede <slug> --row N` — 较新的 take 应替换同页较旧的 chunk 文本（intra_page kind）。
- `voltmind dream --phase synthesize --slug <slug>` — 已策展实体的 compiled_truth 需要更新（cross_slug curated-vs-bulk）。
- `voltmind takes mark-debate <slug> --row N` — 有意保留的分歧（例如两种你希望同时保留的观点）。
- `# manual review: <a> vs <b>` — 裁判不确定；由操作者决定。

运行 `voltmind eval suspected-contradictions review --severity high` 可以在不重新运行探针的情况下检查发现。

## 成本模型

默认裁判是 `claude-haiku-4-5`，约 $1/Mtok 输入、$5/Mtok 输出。v0.32.6 每对内容截断到 1500 字符，约 500 输入 token + 80 输出 token。预算上限默认 TTY 为 $5，非 TTY 为 $1。

- 每次裁判调用约 ~$0.0006
- 每个查询约 ~$0.005（经过日期预过滤 + 缓存命中后）
- 每 100 个查询约 ~$0.50

持久缓存意味着针对同一查询集的夜间运行，在重跑时几乎不再产生费用（直到提升 PROMPT_VERSION）。

## 信任姿态

- 探针从不修改 brain。运行时只读取 pages/takes/chunks。写入只发生在 `eval_contradictions_runs` 和 `eval_contradictions_cache`。
- MCP `find_contradictions` 是只读范围。不在 subagent allowlist 中，只能由用户发起，不是自动行动面。
- 构建 fixture 的脚本仅限本地。redactor + `isCleanForCommit` gate 会让意外提交私有数据变得困难，但操作者必须在提交前检查每一处脱敏。

## See also

- Plan: `~/.claude/plans/system-instruction-you-are-working-hashed-dewdrop.md`
- CHANGELOG: `## [0.32.6]` 条目覆盖整个版本。
- 成本纪律：`docs/eval-bench.md` 说明推荐的夜间节奏和趋势跟踪 workflow。
- **时间轴后续（v0.35.3.1 + v0.35.7）：** v0.35.3.1 增加了六成员 verdict enum（`no_contradiction | contradiction | temporal_supersession | temporal_regression | temporal_evolution | negation_artifact`），并把 `pages.effective_date` 传入裁判 prompt，使探针不再把合法的随时间变化误报为矛盾。v0.35.7 落地探针所指向的 trajectory substrate：`voltmind eval trajectory <entity>` 会显示按时间排序的 typed-claim 历史，并内联标出 regressions；`voltmind founder scorecard <entity>` 把四个信号（accuracy、consistency、growth direction、red flags）汇总为稳定的 JSON contract。MCP op `find_trajectory`（只读范围，对远程调用者做 visibility filter）向 agent 暴露同一数据。探针的 `temporal_supersession` verdict 和 consolidate phase 的 `valid_until` writeback 都保留 `auto-supersession.ts:4` 的 “NEVER auto-applies” 不变量，也就是说探针仍只发出可粘贴命令，只有 `consolidate` 会写 `valid_until`（R1+R8 grep guard 固定了这一点）。
