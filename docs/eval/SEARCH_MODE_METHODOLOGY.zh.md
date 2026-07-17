# Search Mode Evaluation Methodology

_v0.32.3 如何衡量 `conservative`、`balanced` 和 `tokenmax` 之间的差异。写法尽量免疫质疑：每个 claim 都可由已提交 dataset + raw outputs 复现。_

## 1. What this measures and what it doesn't

**Measures:** 在固定公开 datasets 上，针对同一份 brain content，比较每个命名 search mode 的 retrieval quality 和 operational cost。

**Does NOT measure:**
- 你自己的具体 brain content（这是 benchmark，不是你的账单）。
- 你自己的具体 query distribution。
- End-user satisfaction 或 downstream task success。
- 并发负载下的 latency。
- Production cost（成本数字是 model-pricing estimates × dataset size，不是你的实际 API spend）。

如果你想知道某个 mode 在 YOUR brain 上表现如何，请在真实使用窗口后运行 `voltmind search stats --days 30`，再运行 `voltmind search tune` 获取可操作建议。

## 2. Datasets and sizes

- **LongMemEval** — public split，`n=500` questions。从 [Hugging Face](https://huggingface.co/datasets/xiaowu0162/longmemeval) 下载。corpus + answer keys pinned 到特定 commit；记录在每条 per-run record 中。
- **Replay captures** — sibling `voltmind-evals` repo 中的 NDJSON，`n=200` queries。每个 query 带 `retrieved_slugs` baseline + 原 production run 的 `latency_ms` measurement。
- **BrainBench v1** — `n=1240` documents / `n=350` qrels（二元 relevance judgments）。位于 sibling [`voltmind-evals`](https://github.com/garrytan/voltmind-evals) repo，每次 run 都 SHA-pinned。

任何已报告结果都不使用 private brain content。`<repo>/.voltmind-evals/` 下已提交的 NDJSON dumps 只包含 LongMemEval question IDs + rank-ordered retrieved session IDs。

## 3. Sample selection

- **Random seed:** 全程 `42`。通过 `voltmind eval run-all` 的 `--seed N` 设置；记录在每条 per-run record 中。
- **No per-question curation.** Splits 整体使用；没有 question 为报告而被过滤。
- **No mode-specific tuning.** 同一 dataset + 同一 seed 喂给每个 mode。mode 是唯一 independent variable。
- **Stability across re-runs:** 在 `--seed 42` 和相同 dataset SHA 下，同一个（mode, suite）的两次运行会产生相同 retrieval ordering（可选 Haiku expansion call 非 deterministic，属例外）。结果持久化在 `eval_results`，任何人都可从已提交 dumps 重新评分。

## 4. Run procedure

命令即文档。任何人都可复现。

```bash
# Setup: in your voltmind working tree, with OPENAI_API_KEY + ANTHROPIC_API_KEY exported.
git rev-parse HEAD  # record the commit for the methodology footer

# Sweep all 3 modes × 2 retrieval-focused suites with seed 42.
voltmind eval run-all \
  --modes conservative,balanced,tokenmax \
  --suites longmemeval,replay \
  --seed 42 \
  --limit 500 \
  --budget-usd-retrieval 5 \
  --budget-usd-answer 20 \
  --output docs/eval/results/v0.32.3/

# Render the comparison.
voltmind eval compare --md > docs/eval/results/v0.32.3/README.md
voltmind eval compare --json > docs/eval/results/v0.32.3/comparison.json
```

orchestrator 将 per-run records 写入 `<repo>/.voltmind-evals/eval-results.jsonl`。每条 record 包含：`run_id`、`ran_at`、`suite`、`mode`、`commit`、`seed`、`limit`、`params`、`status`、`duration_ms`。`docs/eval/results/v0.32.3/` 下的 dumps 带有 raw question-level outputs，reviewer 可用自己的 metric implementation 重新评分。

## 5. Threats to validity

诚实列表。我们明确哪些点会让批评者有理由驳回数字。

- **LongMemEval skews English + technical.** questions 带有 software-engineering 和 consumer-product 风格。对于富含非英文 / 非技术内容（写作、艺术史等）的 brain，表现可能不同。
- **BrainBench is small**（1240 docs），相对 production brain（10K-100K pages）很小。绝对分数不能预测你的 hit rate；modes 之间的 _delta_ 才重要。
- **char/4 token heuristic.** Token-budget enforcement 和 cost estimates 使用 character-count / 4 heuristic。对 OpenAI tiktoken family 的英文约 5-10% 准确；Voyage 偏差更大（我们不在 chat retrieval 中使用 Voyage，所以不偏置报告数字；但如果你用，budget caps 会是近似值）。
- **Expansion's quality lift varies by query distribution.** eval data 显示在 LongMemEval corpus 上，LLM expansion 相比无 expansion 约有 97.6% relative quality（也就是提升几乎不可测）。在 rarer-entity / longer-tail queries 上，提升可能更大。我们报告的是测过的 corpus；YMMV。
- **Paired bootstrap assumes question-level independence.** 同一 conversation thread 内的 multi-hop questions 并不独立；bootstrap CI 会比现实略窄。
- **Single brain instance per benchmark.** benchmark 为每个 question 启动一个 in-memory PGLite。这里测得的 cache hit rate 不反映长期运行 production brain 的 cache state。

## 6. Per-question raw outputs

每个已报告 metric 都可从提交在 `docs/eval/results/v0.32.3/` 的 NDJSON dumps 复现。methodology footer 中的 commit SHA 固定 code version。

**Examples per mode:** dumps 旁边自动生成的 `README.md` 包含每个 mode 的 winning 和 losing examples，按 deterministic rule 选择：

- **Wins:** 该 mode 的 score 超过 next-best mode 幅度最大的 3 个 questions。
- **Losses:** 该 mode 的 score 低于 next-best mode 幅度最大的 3 个 questions。

按 score delta 选择，NOT cherry-picked by hand。README 记录规则，批评者可以验证。

## 7. Pre-registered expectations

运行前，我们预期：

1. **tokenmax wins Recall@10**，比 conservative 高 5-15 个百分点。LLM expansion + 50-result ceiling 有助于 rare-entity surface forms。
2. **conservative wins cost-per-query**，比 tokenmax 低 5-15×。无 Haiku expansion + 严格 4K budget cap = single-digit-cent queries。
3. **balanced lands within 3pp of tokenmax** on Recall@10。Intent weighting（zero-LLM cost）会缩小 common queries 上的大部分 expansion gap。
4. **No mode breaks nDCG@10 ≥ 0.65** — 技术语料 hybrid retrieval 的公开 “ship it” 阈值。

然后我们发布数据是否支持这些预期。**如果 hypothesis failed，会在 release README 中诚实记录**，不会埋掉。Pre-registration 让比较更可辩护 — 否则 “we expected X and got X” 只是 observation，不是 prediction。

## 8. Re-run cadence

任何触及 retrieval-affecting code 的 release，都会重新生成本文档 + eval results。`voltmind doctor eval_drift` check 会暴露 `src/core/eval/drift-watch.ts` 中 curated watch-list 的变更：

- `src/core/search/**`
- `src/core/embedding.ts`
- `src/core/chunkers/**`
- `src/core/ai/recipes/anthropic.ts`
- `src/core/ai/recipes/openai.ts`
- `src/core/operations.ts`

watch-list 的新增需要 CHANGELOG line。

## Statistical-significance discipline

当 `voltmind eval compare --md` 报告两个 modes 之间的 Δ 时，它会计算：

- **Paired bootstrap**，每个 metric 10,000 resamples。每次 resample 抽取 _question-level_ pairs（同一 question，mode A vs mode B），从而抵消 question-level variance。
- **Bonferroni correction**，覆盖 12 个比较（3 modes × 4 metrics）。报告的 p-value 是该比较 raw p-value × 12（封顶 1.0）。
- **95% confidence intervals**，从 bootstrap distribution 计算。

如果某个 Δ 的 CI 包含 0，OR Bonferroni-adjusted p-value 超过 0.05，则差异 **not** statistically significant。MD report 会原文写出 "not significant"。

## Glossary

报告打印的每个 metric 在 `docs/eval/METRIC_GLOSSARY.md` 中都有 plain-English entry，该文件由 `src/core/eval/metric-glossary.ts` 自动生成。`scripts/check-eval-glossary-fresh.sh` 中的 CI guard 会在每次 test run 中 regenerate 并与已提交文件 diff；stale doc 会使 build 失败。

## Cost anchors

`voltmind init` 的 mode-picker prompt 和 CLAUDE.md 的 `## Search Mode` table 都会显示这些粗略 cost anchors。下面展开数学过程，便于审计：

**Variables:**
- `T` = 每个 search-result chunk 的平均 tokens。recursive chunker 目标为 300 words / chunk → 约 400 tokens（英文，OpenAI tiktoken 近似）。
- `N` = 每个 query 交付的 chunks（由 mode 的 `searchLimit` 限制）。
- `R` = downstream model input rate。Sonnet 4.6 = \$3/M。Opus 4.7 = \$5/M。Haiku 4.5 = \$1/M。
- `Q` = 每月 queries。

**Per-query input cost**（downstream agent 读取 chunks）：

    cost_per_query = T × N × R

| Mode | T (tokens) | N (chunks) | Sonnet (\$3/M) | Opus (\$5/M) | Haiku (\$1/M) |
|---|---|---|---|---|---|
| conservative (4K cap, 10 max) | ~400 | 10 (or fewer if budget hits) | \$0.012 | \$0.020 | \$0.004 |
| balanced (12K cap, 25 max) | ~400 | ~25 | \$0.030 | \$0.050 | \$0.010 |
| tokenmax (no cap, 50 max) | ~400 | ~50 | \$0.060 | \$0.100 | \$0.020 |

**Monthly cost**（Q × per-query）：

| Mode @ Sonnet | 1K Q/mo | 10K Q/mo | 100K Q/mo |
|---|---|---|---|
| conservative | \$12 | \$120 | \$1,200 |
| balanced | \$30 | \$300 | \$3,000 |
| tokenmax | \$60 | \$600 | \$6,000 |

| Mode @ Opus | 1K Q/mo | 10K Q/mo | 100K Q/mo |
|---|---|---|---|
| conservative | \$20 | \$200 | \$2,000 |
| balanced | \$50 | \$500 | \$5,000 |
| tokenmax | \$100 | \$1,000 | \$10,000 |

**voltmind's own cost** on top:
- Query embedding（text-embedding-3-large @ \$0.13/M tokens）：每 query 约 \$0.00001。任意规模下都可忽略。
- Tokenmax Haiku expansion call（\$1/M input，\$5/M output，约 500 input + 200 output per call）：每 query 约 \$0.0015，100K queries 时约 \$150/mo。Cache hits 会将其减半。
- Per-page indexing（one-time）：由 import volume 限制，而非 query volume。这里不建模。

**Cache hit adjustment.** warmed brain 通常在 repeat-query traffic 上看到 30-50% cache hits。Cache hits 会完全跳过 downstream input cost（cached result 已经进入过 agent context）。所以繁忙 brain 的真实成本通常是上表的约 50-70%。

**Why these numbers DRIFT from your actual bill:**
- 你的 agent system prompt + reasoning tokens 会增加 voltmind 看不到的 input。
- 长 session 中 compaction 会减少 input。
- 多数 agents 每 turn 做 1-5 次 searches；账单看的是 cost-per-turn，而不是 cost-per-query。
- model price column 会随 providers 重新定价而漂移；当前快照请通过 `src/core/anthropic-pricing.ts` 固定 rate。

picker copy + CLAUDE.md table 是 canonical user-facing source。当底层 chunker size 或默认 `searchLimit` 变化时，请同步更新它们。

## Mode × Model matrix (the 25x spread)

上面的 per-query math 假设 downstream 是 Sonnet 4.6。现实中，downstream model tier 是更大的成本杠杆。10K queries/month（典型单用户体量）、仅 search payload（无 cache savings）的 per-query cost：

| Mode (search tokens) | Haiku 4.5 (\$1/M) | Sonnet 4.6 (\$3/M) | Opus 4.7 (\$5/M) |
|---|---|---|---|
| conservative (~4K) | **\$40/mo** | \$120/mo | \$200/mo |
| balanced (~10K) | \$100/mo | \$300/mo | \$500/mo |
| tokenmax (~20K) | \$200/mo | \$600/mo | **\$1,000/mo** |

线性扩展：100K/mo（heavy power user / multi-user fleet）乘以 10；1K/mo（light usage）除以 10。

**Natural pairings span ~4x**（cheap model + tight mode → frontier model + loose mode）。**Mismatches waste capacity:**

- `tokenmax + Haiku`: Haiku 每 query 被塞入 20K search results。Haiku 的 reasoning 更弱；更多 chunks = 更多噪声，不是更多信号。你付 Haiku 费率，但得到 sub-Haiku quality。方向错了。
- `conservative + Opus`: Opus 有 200K context window，可以跨许多 chunks synthesize。限制为 10 chunks / 4K tokens 会让 Opus reasoning underfed。你付 Opus 费率，却得到 conservative-shape retrieval。浪费。

**Right-sizing rule:** 将 mode 的 `searchLimit` 匹配到 downstream model 的 “useful context depth”：

- Haiku 在约 5-10 个 cross-referenced content chunks 后开始吃力 → conservative
- Sonnet 能很好处理约 25-40 chunks → balanced
- Opus 在 multi-hop reasoning 中受益于 50+ chunks → tokenmax

## Realistic-scale anchor (single power-user agent loop)

上面的 per-query math 诚实但理论化：它把每次 search 当作孤立计费事件。真实 agent loops 通过 Anthropic prompt caching 在 turns 之间摊销大量 context。下面是一个重度 power-user loop 在 production 中的真实形态，已匿名化并缩放，使数字代表一个有代表性的 power user，而非任何具体部署。

**Reference shape — tokenmax in production at a single-user scale:**

| Quantity | Approximate value |
|---|---|
| 30-day total agent spend | ~\$700/mo |
| 30-day total tokens billed | ~800M |
| Turns per month | ~860 (~29/day; one active agent loop) |
| Average tokens per turn | ~900K |
| Average cost per turn | ~\$0.85 |
| Anthropic prompt-cache hit rate | ~88% |

这里的 “turn” 是一次 agent loop iteration：读取用户消息、计划、执行 tool calls（包括 voltmind searches）、生成响应。每个 turn 通常包含 2-4 次 voltmind searches。

**Per-mode scaling from the tokenmax anchor:**

modes 之间的成本差集中在每 turn 成本中 search-attributable 的部分。System prompt、tool definitions、conversation history 和 reasoning tokens 不随 mode 改变 — 只有 voltmind 交付的 chunks 会变。假设每 turn 3 次 searches，使用 mode 的 `searchLimit`：

| Mode | Search tokens/turn | Search cost/turn (at \$3/M effective) | Search-attributable @ 860 turns | Δ vs tokenmax |
|---|---|---|---|---|
| tokenmax | ~60K (3 × 20K) | ~\$0.18 | ~\$155/mo | — |
| balanced | ~30K (3 × 10K) | ~\$0.09 | ~\$77/mo | -\$78 |
| conservative | ~12K (3 × 4K) | ~\$0.036 | ~\$31/mo | -\$124 |

**Implied total agent spend by NATURAL PAIRING**（mode + 匹配的 downstream model）。Per-turn cost 会随 downstream model 的 per-token rate 缩放，因为 cached prefix + uncached portion + reasoning tokens 都按该 rate 计费：

| Pairing | Per-turn cost | Total @ 860 turns/mo |
|---|---|---|
| tokenmax + Opus (frontier, max quality) | ~\$0.85 | ~\$700/mo |
| balanced + Sonnet (the sweet spot) | ~\$0.50 | ~\$430/mo |
| conservative + Haiku (cost-sensitive) | ~\$0.20 | ~\$170/mo |

**4x spread across natural pairings.** model tier 占主导，因为 per-token rate 作用于 WHOLE per-turn payload（system + tools + history + reasoning + search），不只是 voltmind chunks。Mode choice 在该 base 之上贡献约 10-20%。

**Mismatched pairings push you off the curve:**

| Pairing | Per-turn estimate | Total @ 860 turns/mo | Compared to natural |
|---|---|---|---|
| tokenmax + Haiku | ~\$0.20 | ~\$170/mo | Same cost as conservative+Haiku, worse quality |
| conservative + Opus | ~\$0.75 | ~\$640/mo | 92% of tokenmax+Opus spend, conservative-shape retrieval |

mismatch math 表明：tokenmax+Haiku 用户付出与 conservative+Haiku 相同的成本，却得到更嘈杂的 context（Haiku 无法从 50 chunks 中过滤 signal）。conservative+Opus 用户付出几乎与 tokenmax+Opus 相同的成本，却让 Opus 在 retrieval depth 上挨饿。两者都烧预算却没有改进。

**What this anchor tells us that the per-query math doesn't:**

1. **在带有 disciplined prompt caching 的现实 agent-loop scale 下，mode choice 节省 total agent spend 的 10-20%** — 有意义，但比 per-query 5x ratio 暗示的更小。Disciplined prompt-cache layouts 会钝化 mode delta，因为大部分 per-turn cost 是 cached prefix，而不是 search payload。

2. **没有这种 prompt-cache discipline，per-query framing 会重新占主导。** 如果 setup 每 turn 都搅动 prompt prefix（频繁 system-prompt edits、未模板化 tool defs、无 prompt-cache structuring），search payload 会占 total cost 的更大比例。这类 setup 应该更关心 mode choice，而不是更少。

3. **这里引用的 cache hit rate（~88%）可实现，但不是自动的。** 它要求结构化 prompt，使 cached prefix 在 turns 之间稳定：system prompt + tool defs 在前，history compacted but cache-aware，retrieved chunks 追加在 LAST（它们的波动不会使 prefix 失效）。把 search results 交错放进 cached region 的 agents 会在每个 turn 支付 prefix-rebuild tax。

**Caveats stacked here:**

- anchor 代表 ONE power-user loop。Multi-user fleets 按比例聚合；per-user shape 不变。
- “3 searches per turn” 假设变化很大。code-review agent 可能每 turn 发出 10+ searches；chat-only loop 可能为 0。
- 88% cache hit rate 是可达范围的高端。没有 cache-aware prompt layout 的默认 agent 更接近其一半。
- “Δ vs tokenmax” math 假设 OTHER cost components（system、tools、history、reasoning）保持不变。实践中，conservative 更小的 per-turn payload 也为 history 留出更多 context window 空间 → 这可能以任一方向改变 agent behavior。

这个 anchor + per-query math 都有意放在本文档中。per-query framing 是 isolated benchmark 会测到的东西（也是 `voltmind eval run-all` 会产生的东西）。realistic-scale anchor 是 operator 实际支付的东西。两者都诚实；都不是完整真相。

## Reproducibility footer

每个发布 eval numbers 的 release 都包含 footer：

- Code commit SHA
- Dataset SHA（LongMemEval、BrainBench、Replay）
- `--seed N`
- Run commands verbatim
- 使用的 API model identifiers（Anthropic + OpenAI + judge model）

没有这些，数字不可证伪。有了它们，任何有 API keys 的人都能重新评分。
