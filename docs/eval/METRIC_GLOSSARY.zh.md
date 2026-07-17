# Evaluation Metric Glossary

**Auto-generated from `src/core/eval/metric-glossary.ts`. Do not edit by hand.** 运行 `bun run scripts/generate-metric-glossary.ts` 重新生成。

每个由 `voltmind eval *` 和 `voltmind search stats` 报告的 metric，都在这里有一段普通英文解释。行业术语保留原文，方便用户搜索文献时能对应到我们报告的内容。

## Retrieval Metrics

### Precision at k (P@k)

**Key:** `precision@k`

**Plain English:** 在 engine 返回的 top k 结果中，实际相关的比例是多少？高 precision 表示列表顶部的垃圾结果很少。

**Range:** 0..1，越高越好。P@10 = 0.7 表示前 10 个结果中有 7 个切题。

### Recall at k (R@k)

**Key:** `recall@k`

**Plain English:** 在 brain 中所有存在的相关结果里，engine 在它的 top k 中找到了多少比例？高 recall 表示漏掉的答案少。

**Range:** 0..1，越高越好。R@10 = 0.81 表示每 100 个问题中，有 81 个问题的正确答案出现在前 10 个结果里。

### Mean Reciprocal Rank (MRR)

**Key:** `mrr`

**Plain English:** 平均来看，第一个相关结果在列表中排多靠下？MRR 为 1.0 表示第一个命中总是正确；MRR 为 0.5 表示通常在第 2 位。

**Range:** 0..1，越高越好。计算方式是对所有测试查询求 1/rank-of-first-relevant-result 的平均值。

### Normalized Discounted Cumulative Gain at k (nDCG@k)

**Key:** `ndcg@k`

**Plain English:** 类似 precision@k，但 engine 把好结果放在越靠前的位置，就获得越多 credit。完美排序得 1.0；完全随机排序接近 0。

**Range:** 0..1，越高越好。对于技术语料上的 hybrid retrieval，nDCG@10 高于 0.65 是常见的 “ship it” 阈值。

## Set-Similarity / Stability Metrics

### Jaccard similarity at k (set Jaccard @k)

**Key:** `jaccard@k`

**Plain English:** 两个结果列表有多少重叠？把 captured baseline 的 top k slugs 与当前运行对比；Jaccard@10 = 1.0 表示完全一致，0.0 表示没有任何重叠。

**Range:** 0..1，越高 = 越稳定。在稳定语料上低于 0.5 表示 retrieval 发生显著变化。

### Top-1 stability rate

**Key:** `top1_stability`

**Plain English:** 两次运行中 #1 结果相同的查询比例。最激进的稳定性检查 — 不改变 top answer 的小幅排名变动不会伤害它。

**Range:** 0..1，越高 = 越稳定。高于 0.85 通常意味着 retrieval changes 可以安全合并。

## Statistical-Significance Metrics

### p-value (paired bootstrap)

**Key:** `p_value`

**Plain English:** 两种模式之间观察到的差异有多大可能只是噪声。越低 = 差异真实的证据越强。我们使用 10,000 次 resamples 的 paired bootstrap，并对 12 个比较（3 modes × 4 metrics）做 Bonferroni correction。

**Range:** 0..1，越低 = 信号越强。低于 0.05 是常见的 “statistically significant” 阈值；低于 0.01 是强证据。

### 95% Confidence Interval (CI)

**Key:** `confidence_interval`

**Plain English:** 基于我们测量到的 sample，我们有 95% 把握真值落入的区间。CI 越窄 = 估计越可靠。通过 bootstrap resampling 计算。

**Range:** 二元组 [low, high]。如果某个 Δ 的 CI 包含 0，则差异不具备统计显著性。

## Operational / Cost Metrics

### Cache hit rate

**Key:** `cache_hit_rate`

**Plain English:** 搜索中复用近期缓存答案、而不是重新运行的比例。更高 hit rate = 更低延迟 + 更低 LLM 花费，但如果阈值过松，陈旧结果可能溜进来。

**Range:** 0..1，通常越高越好。对繁忙 brain 来说 0.7-0.9 是甜点区；高于 0.9 可能表示 similarity threshold 太松。

### Average results returned

**Key:** `avg_results`

**Plain English:** 每次调用 engine 返回的 search-result rows 平均数量。除非 brain 很小或 budget 正在丢弃结果，否则应接近 active mode 的 searchLimit。

**Range:** 0..searchLimit。远低于 searchLimit 暗示 budget pressure 或 sparse retrieval。

### Average tokens delivered

**Key:** `avg_tokens`

**Plain English:** 每次搜索调用返回的 chunk text 中估算 tokens（chars / 4）。这是 agent loop 为每次搜索支付多少上下文的直接度量。

**Range:** 0..tokenBudget。近似 OpenAI tiktoken 的英文计数；Anthropic 会偏差约 5-10%，非英文更差。

### Cost per query (USD)

**Key:** `cost_per_query_usd`

**Plain English:** 一次搜索调用的 LLM + embedding API 费用之和。包括 Haiku expansion call（仅 tokenmax mode）+ embedding cost + downstream answer-model cost（如果测量）。

**Range:** 0..unbounded。Conservative mode 通常每次调用 <\$0.001；带 answer-gen 的 tokenmax 可超过 \$0.01。

### p99 latency (ms)

**Key:** `p99_latency_ms`

**Plain English:** 每次搜索调用 wall-clock time 的第 99 百分位。也就是 1% 用户会看到的延迟 — 长尾体验，不是平均值。

**Range:** 0..unbounded。Warm-cache hits 应 <50ms；带 expansion 的 tokenmax 可能因 Haiku 调用超过 200ms。

---

## Coverage

任何 `voltmind eval *` 或 `voltmind search stats` 命令打印的每个 metric，都会通过 `src/core/eval/metric-glossary.ts` 中的 `getMetricGloss()` 解析。向 glossary 添加新 metric REQUIRES 更新本文档；CI guard 会捕获 drift。
