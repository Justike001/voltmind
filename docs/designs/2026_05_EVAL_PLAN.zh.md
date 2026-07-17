# Embedder 对决 — 2026 年 5 月评测计划

**状态：** 已批准，准备执行
**Owner：** Garry
**计划来源：** `~/.claude/plans/system-instruction-you-are-working-linear-origami.md`（review log）
**目标 wallclock：** 约 2 周
**目标 API 花费：** 约 $525（硬上限 $700）

## 这是什么

在 v0.35.0.0 新的多供应商 gateway routing 下，对三个 embedding provider 做 head-to-head A/B/C 对比：

- **OpenAI** `text-embedding-3-large` @ 1536 dims
- **Voyage** `voyage-4-large` @ 2048 dims
- **ZeroEntropy** `zembed-1` @ 2560 dims（另有 1280 维 Matryoshka 消融）

每个都分别测试带与不带 `zerank-2` reranker。两个语料：公开 LongMemEval（500q）和内部 BrainBench（145 个关系查询 + 50 个新整理的 Cat 13 embedder-sensitive queries）。

目标：产出一份可发布的对比报告，回答“哪个 embedder 胜出，以及 zerank-2 是否替 ZeroEntropy 扛起胜利”，附 bootstrap p-values，适合作为 v0.35.2.0 release-note headline。

## 为什么这样设计

规划 review 中锁定的决策（见计划文件 + 链接计划底部的 `GSTACK REVIEW REPORT`）：

- **仅 synthetic** — LongMemEval（公开）+ BrainBench（内部）。不用 `~/.voltmind` 数据。
- **Answer-gen mode** — `voltmind eval longmemeval` 运行默认 answer-gen 路径（Anthropic Sonnet），然后把产出的 hypothesis JSONL 交给 LongMemEval 已发布的 `evaluate_qa.py`（OpenAI gpt-4o judge）以得到真实 correctness 数字。**不使用** `--retrieval-only`（会产生容易被攻击的 headline；judge 期待的是答案文本，不是检索文本）。
- **`tokenmax` search mode** 在所有 cell 中固定（expansion + reranker slot active）。
- **单 workspace 串行执行**。Rate-limit profile 干净；ZE 首次接触运行需要可调试信号。
- **7-cell matrix**（没有 matched-dim cross-vendor 行；三家供应商之间不存在共同维度，诚实表述是“每家供应商使用其市场化 sweet spot”）。

## 限制计划的架构事实

- `content_chunks.embedding vector(N)` 的维度按 brain 固定。LongMemEval 中 per-question PGLite 让这点免费；BrainBench 每个 cell 需要单独 brain。
- pgvector HNSW 上限为 **2000 dims**（`src/core/vector-index.ts:19` 中的 `PGVECTOR_HNSW_VECTOR_MAX_DIMS`）。Voyage 2048 和 ZE 2560 回退到精确 vector scan。有助于质量（没有 HNSW 近似），但增加延迟。会在 writeup 中脚注。
- 关闭 reranker 的 key 是 **`search.reranker.enabled false`**，不是 `reranker_model none`。`tokenmax` mode 默认 reranker=true。
- `voltmind/ai/gateway` 在 v0.35.0.0 中没有导出。PR α 会暴露它。

## Matrix

| Cell | Embedder | Dim | HNSW | Reranker | Notes |
|---|---|---|---|---|---|
| A0 | `openai:text-embedding-3-large` | 1536 | yes | none | OpenAI baseline |
| A1 | `openai:text-embedding-3-large` | 1536 | yes | `zerank-2` | mixed-vendor |
| B0 | `voyage:voyage-4-large` | 2048 | no (exact) | none | Voyage solo |
| B1 | `voyage:voyage-4-large` | 2048 | no (exact) | `zerank-2` | mixed-vendor |
| C0 | `zeroentropyai:zembed-1` | 2560 | no (exact) | none | ZE embedder solo |
| C1 | `zeroentropyai:zembed-1` | 2560 | no (exact) | `zerank-2` | **ZE full stack** |
| C2 | `zeroentropyai:zembed-1` | 1280 | yes | `zerank-2` | ZE-Matryoshka ablation |

## PR 结构 — 越少越好

**PR α — voltmind repo: v0.35.1.0 infra。** 打包所有 voltmind 变更。最先落地。内部 commit 保持 bisect-friendly，最后才 ship。

**PR β — voltmind-evals repo: adapter + smoke + curation + eval receipts + writeup。** 大 PR。包含完整 eval-run 输出，与产生它的代码一起提交，再加对比 writeup。全部完成后落地。

**PR γ（可选）— voltmind repo: v0.35.2.0 release**，在 CHANGELOG 中 cross-link voltmind-evals benchmark。小 commit，无代码变更。

总计：2 个实质 PR + 1 个可选 release commit。**不中途 ship。**

## Conductor sessions

下面每节都是自包含 brief。复制粘贴到新的 Conductor session 即可交接。每个 session 都以干净 deliverable 结束。

---

## Session 1 — PR α: voltmind infra (v0.35.1.0)

**Repo:** `/Users/garrytan/conductor/workspaces/voltmind/<NEW-WORKSPACE>`（从 `master` 新建）
**Branch:** `garrytan/v0.35.1.0-infra`
**Wallclock:** 约 2h
**API spend:** $0

### 本 session 交付什么
三个变更合并进一个 PR，让 voltmind-evals 中的 embedder shootout（PR β）拥有干净的 prereq baseline：

1. 将 `voyage:voyage-4-large`（$0.18/M）和 `zeroentropyai:zembed-1`（$0.05/M）加入 embedding pricing table。修补 `voltmind models doctor` cost estimator + test。
2. 在 `package.json` exports map 中暴露 `voltmind/ai/gateway`，让 voltmind-evals adapter 可以从 voltmind 进程外调用 `configureGateway({embedding_model, embedding_dimensions, reranker_model})`。
3. 给 `voltmind eval longmemeval` 添加 `--resume-from <jsonl>`，使中途 abort（rate-limit、cost-cap、OS interrupt）不会丢掉已经付费跑完的 cell。

最终以 v0.35.1.0 ship。

### Prereqs（开始前验证）
- voltmind master 位于 v0.35.0.0 baseline。`cat VERSION` 显示 `0.35.0.0`。
- master 上 `bun test` 和 `bun run verify` 都通过。

### Commits（bisect-friendly，每个 commit 一个功能）

```
1. feat(pricing): add voyage-4-large + zembed-1 to EMBEDDING_PRICING
   - src/core/embedding-pricing.ts: add both entries
   - test/embedding-pricing.test.ts: pin both with $0.18 and $0.05
   - Verify: bun test test/embedding-pricing.test.ts

2. feat(exports): expose voltmind/ai/gateway with canary test
   - package.json: add "./ai/gateway" to exports map
   - test/public-exports.test.ts: add canary for configureGateway + embed
   - scripts/check-exports-count.sh: 17 -> 18
   - Verify: bun run verify

3. feat(eval): add --resume-from <jsonl> to longmemeval
   - src/commands/eval-longmemeval.ts: parse flag, skip questions already in input JSONL
   - test/eval-longmemeval.test.ts: simulated mid-run abort + resume regression
   - Verify: bun test test/eval-longmemeval.test.ts

4. chore: v0.35.1.0
   - VERSION: 0.35.1.0
   - package.json: 0.35.1.0
   - CHANGELOG.md: new entry
   - bun install (refresh lockfile)
```

### /ship 前验证
```bash
bun run typecheck
bun run verify
bun test test/embedding-pricing.test.ts test/public-exports.test.ts test/eval-longmemeval.test.ts
```

### Ship
```bash
/ship
```

### Deliverable
- voltmind 的 `master` 位于 v0.35.1.0
- 外部消费者可访问 `voltmind/ai/gateway`（由 canary test 验证）
- `git tag eval-run-v0.35.1.0-baseline`（annotated，指向这个精确 commit）
- `voltmind --version` 打印 `0.35.1.0`

### 交接给 Session 2
- voltmind-evals 现在可以 `bun update voltmind` 到 v0.35.1.0
- tag 保存了精确 commit，满足未来可复现性需求

---

## Session 2 — PR β setup: voltmind-evals adapter + smoke + subset flag

**Repo:** `/Users/garrytan/git/voltmind-evals`（或从它 clone 的新 Conductor workspace）
**Branch:** `garrytan/embedder-shootout`
**Wallclock:** 约 3-4h
**API spend:** 约 $0.10（仅 smoke verification call）

### 本 session 写入 PR β 的内容（此时不 merge）
将 harness 接到新暴露的 voltmind gateway，以驱动 3 个 embedding provider：

1. 新的 typed `EvalAdapterConfig {embedder, dim, reranker?}` 传给每个 adapter。
2. 重写 `vector.ts` + `hybrid-rrf.ts`，调用来自 `voltmind/ai/gateway` 的 `configureGateway()`，而不是 hardcoded `voltmind/embedding` import。
3. 关键：hybrid adapter 还必须路由 `search.reranker.enabled`（true/false）和 `search.mode`（tokenmax）——codex 指出现有 hybrid 从未设置这些。
4. 新的 3-phase smoke harness：wiring（5 queries × embed roundtrip + dim check）+ long-haystack（1 query × 50K-token synthetic haystack）+ rerank-payload（1 query × `topNIn=30`）。退出码就是 gate。
5. BrainBench runner 新增 `--include-subset <name>` flag（Cat 13 wiring；subset 本身在 Session 3）。

### Prereqs
- Session 1 完成。voltmind master 位于 v0.35.1.0。
- API keys 存在：`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`VOYAGE_API_KEY`、`ZEROENTROPY_API_KEY`。Smoke 对缺失 key fail loud。

### Commits

```
1. chore(deps): bump voltmind pin to v0.35.1.0
   - package.json + bun.lock
   - Verify: bun install && bun run typecheck

2. feat(adapter): typed EvalAdapterConfig + gateway swap
   - NEW: eval/runner/eval-adapter-config.ts (the type)
   - eval/runner/adapters/vector.ts: constructor takes EvalAdapterConfig,
     calls configureGateway({embedding_model, embedding_dimensions})
   - Drop hardcoded voltmind/embedding import
   - Verify: existing vector adapter unit tests still pass

3. feat(adapter): hybrid-rrf wires reranker_enabled + search.mode
   - eval/runner/adapters/hybrid-rrf.ts: constructor takes EvalAdapterConfig,
     plumbs search.reranker.enabled + search.mode = tokenmax through
   - Verify: bun test eval/

4. feat(smoke): 3-phase smoke harness
   - NEW: eval/runner/smoke.ts (CLI entry: bun run eval:smoke -- --embedder X --dim Y [--reranker Z])
   - Phase 1: 5 queries × embed roundtrip, assert vector dim matches config
   - Phase 2: 1 query × synthetic 50K-token haystack, assert no token-limit error
   - Phase 3: 1 query × topNIn=30 documents, assert no 5MB payload cap hit
   - Non-zero exit on any failure
   - Verify: bun run eval:smoke -- --embedder openai:text-embedding-3-large --dim 1536

5. feat(runner): --include-subset flag for BrainBench
   - eval/runner/multi-adapter.ts: parse flag, filter queries by subset tag
   - Subset itself comes in next commit (Session 3)
   - Verify: bun run eval:run -- --include-subset cat13-embedder (errors politely because subset file doesn't exist yet)
```

### Smoke verification（打开 PR 前手动运行）
```bash
bun run eval:smoke -- --embedder openai:text-embedding-3-large --dim 1536
bun run eval:smoke -- --embedder voyage:voyage-4-large --dim 2048
bun run eval:smoke -- --embedder zeroentropyai:zembed-1 --dim 2560
bun run eval:smoke -- --embedder zeroentropyai:zembed-1 --dim 2560 --reranker zeroentropyai:zerank-2
```

四个命令都必须 exit 0。报告应打印 observed vector dim，并与 configured dim 匹配。

### 打开 PR β
```bash
gh pr create --base main --title "feat: embedder shootout (adapter + smoke + Cat 13 + eval receipts)" --body "$(cat <<'EOF'
## Summary
v0.35.0.0 shipped ZeroEntropy zembed-1 + zerank-2 reranker support. This PR runs a head-to-head A/B/C comparison across OpenAI, Voyage, and ZeroEntropy under the new gateway routing.

This first commit batch lands the harness. Cat 13 curation, Phase 1+2 evals, and the
writeup follow in subsequent commits to this same PR.

## Test plan
- [x] Adapter unit tests pass
- [x] Smoke harness exits 0 against all 3 providers
- [ ] Cat 13 subset committed (Session 3)
- [ ] LongMemEval x 7 cells run (Session 4)
- [ ] BrainBench x 7 cells run (Session 5)
- [ ] Writeup committed (Session 5)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Deliverable
- PR β 已对 voltmind-evals `main` 打开，CI 绿
- 已对全部 3 个 provider 验证 smoke（把 smoke 输出贴进 PR body）
- 分支已准备好给 Session 3（Cat 13 curation）

### 交接给 Session 3
- 分支 `garrytan/embedder-shootout` 已存在于 origin
- `--include-subset cat13-embedder` flag 已接线，但 subset 文件还不存在——那是 Session 3

---

## Session 3 — PR β: Cat 13 conceptual-recall curation

**Repo:** `/Users/garrytan/git/voltmind-evals`，分支 `garrytan/embedder-shootout`（同 Session 2）
**Wallclock:** 约 3-4h（强用户交互；AI 提案，你逐条 review）
**API spend:** $0

### 本 session 写入 PR β 的内容
从 BrainBench 的 Cat 13（conceptual recall）语料中手工整理 50 个 embedder-sensitive queries。这些查询是 graph/keyword adapter 可能漏掉、但 semantic adapter 应能找到的那类。

Codex 指出现有 145-query relational corpus 主要受 graph/keyword 支配，不适合支撑 embedder claim。Cat 13 更接近 embedder-sensitive workload，但需要手工筛选。

### Prereqs
- Session 2 完成。PR β 已打开，包含 adapter + smoke + subset flag。

### Workflow
交互式：Claude 每批提出 10 个 query，你逐个 accept/reject/edit。

1. Claude 读取现有 Cat 13 raw query pool：
   ```bash
   ls eval/data/raw/ | grep -i cat13
   cat eval/data/raw/cat13-*.json | jq '.'
   ```
2. Claude 每批提出 10 个候选 query，每个都带 inclusion reasoning（“graph adapter 会错过它吗？”）。
3. 用户 inline accept/reject/edit。目标：50 queries × 约 5 批。
4. Claude 提交到 `eval/data/gold/brainbench-cat13-embedder-subset.json`：
   ```json
   {
     "schema_version": 1,
     "subset": "cat13-embedder",
     "queries": [
       {
         "id": "cat13-emb-001",
         "query": "...",
         "relevant_chunk_ids": ["..."],
         "inclusion_reason": "paraphrase relationship; graph adapter wouldn't catch the synonym"
       }
       // ... 49 more
     ]
   }
   ```

### Commit

```
feat(eval): curate Cat 13 conceptual-recall subset (50 embedder-sensitive queries)
- NEW: eval/data/gold/brainbench-cat13-embedder-subset.json
- Each query tagged with inclusion_reason for future audit
```

### Commit 前 spot-check
- 随机挑 5 个 query，用假设 graph adapter（例如 grep relevant terms）跑一下，确认它们不会 surfacing 正确 chunk。
- 同样 5 个用现有 hybrid adapter 跑，确认它们会命中。

### Deliverable
- `eval/data/gold/brainbench-cat13-embedder-subset.json` 已提交到 PR β
- 恰好 50 个 query
- Spot-check 证据写入 commit message

### 交接给 Session 4
- PR β 现在包含：adapter + smoke + Cat 13 subset
- 可以开始真正 eval run

---

## Session 4 — PR β Phase 1: LongMemEval × 7 cells（overnight）

**Repo:** 同一 voltmind-evals 分支
**Wallclock:** 约 10.5h（主要无人值守，启动后离开）
**API spend:** 约 $476（LongMemEval-heavy；7 × $68/cell）

### 本 session 写入 PR β 的内容
7 个 LongMemEval scored receipts（matrix 中每个 cell 一个）。每个包含 500 条 hypothesis 的 JSONL，以及来自 `evaluate_qa.py` 的 correctness scores JSON 文件。

### Prereqs
- Sessions 1+2+3 完成。PR β 包含 adapter + smoke + Cat 13。
- LongMemEval dataset 已下载（gated HuggingFace；一次性设置）。
- `evaluate_qa.py` 已在某处 checkout（来自 https://github.com/xiaowu0162/LongMemEval），并有自己的 venv。
- API keys：`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`VOYAGE_API_KEY`、`ZEROENTROPY_API_KEY`。

### Wrapper script
Claude 在 voltmind-evals 分支中写 `scripts/run-shootout-phase1.sh`。单入口，串行循环 7 个 cell，带 smoke gating + cost-cap aborts。

```
NEW: scripts/run-shootout-phase1.sh
- Per cell: voltmind config set (embedder, dim, reranker, search.reranker.enabled, search.mode=tokenmax)
- Per cell: bun run eval:smoke (abort cell on non-zero)
- Per cell: voltmind eval longmemeval ... --output results/longmemeval-{cell}.jsonl
- Per cell: cost-cap check ($90/cell hard stop)
- Per cell: --resume-from existing results/longmemeval-{cell}.jsonl if present
- Logs to results/phase1-run-log.txt
```

### Run
```bash
# Kick off in background; check back in 10-12h
bash scripts/run-shootout-phase1.sh 2>&1 | tee results/phase1-run-log.txt &
```

如果通过 Claude 运行，使用 `run_in_background: true`。定期回来检查。

### Scoring（全部 7 个 cell 完成后）
```bash
for cell in A0 A1 B0 B1 C0 C1 C2; do
  python evaluate_qa.py \
    --input results/longmemeval-${cell}.jsonl \
    --output results/longmemeval-${cell}-scored.json
done
```

每个 scored 文件都有 correctness %。

### Commits

```
1. feat(scripts): Phase 1 LongMemEval wrapper with smoke gating + cost cap
   - NEW: scripts/run-shootout-phase1.sh

2. data(phase1): 7 LongMemEval cells (raw hypothesis JSONL)
   - results/longmemeval-{A0,A1,B0,B1,C0,C1,C2}.jsonl
   - results/phase1-run-log.txt (run timing + cost ledger)

3. data(phase1): evaluate_qa.py scoring results
   - results/longmemeval-{cell}-scored.json × 7
```

### Verify
- 每个 `longmemeval-{cell}.jsonl` 恰好 500 行
- 每个 `hypothesis` 字段非空，且是真正答案文本（不是 retrieval text）
- 每个 `scored.json` 有 `correctness_score` 字段

### Deliverable
- 7 个 scored LongMemEval receipts 已提交到 PR β
- 真实 cost ledger 一并提交（与估算对比）

### 交接给 Session 5
- Phase 1 完成。剩下 Phase 2（BrainBench，约 3.5h）和 writeup。

---

## Session 5 — PR β Phase 2 + writeup + ship

**Repo:** 同一 voltmind-evals 分支
**Wallclock:** 约 7h（3.5h BrainBench + 3h writeup + /ship）
**API spend:** 约 $56（BrainBench 便宜）

### 本 session 写入 PR β 的内容
- 7 个 BrainBench cells（relational corpus + Cat 13 subset）
- 最终对比 writeup
- PR β merge

### Prereqs
- Session 4 完成。PR β 有 Phase 1 receipts。

### Phase 2 wrapper script
```
NEW: scripts/run-shootout-phase2.sh
- Per cell: configure provider (same as Phase 1)
- Per cell: bun run eval:run -- --N 10 --include-subset cat13-embedder
  --output docs/benchmarks/2026-05-22-{cell}.md
- Cost-cap check
```

### Run
```bash
bash scripts/run-shootout-phase2.sh 2>&1 | tee results/phase2-run-log.txt
```

### Writeup
`docs/benchmarks/2026-05-22-embedder-shootout.md`。结构：

1. **Headline table** — 7 cells × {LongMemEval correctness %, BrainBench relational MRR + P@5, Cat 13 correctness %, total cost}
2. **回答两个问题：**
   - 哪个 embedder solo 胜出？（A0 vs B0 vs C0）
   - zerank-2 是否扛起 ZE 的胜利？（C0 vs C1 vs A1 vs B1）
   - Bonus：ZE 的维度是否重要？（C1 vs C2）
3. **Paired-bootstrap p-values**，用于 headline pair（方法论在 `voltmind/docs/eval/SEARCH_MODE_METHODOLOGY.md`）
4. **HNSW footnote** — Voyage 2048 和 ZE 2560 使用 exact vector scan；OpenAI 1536 和 ZE 1280 使用 HNSW。质量优先，延迟次之
5. **What this does NOT prove** — synthetic-only、tokenmax-only、无 real-brain replay
6. **Recommendation:** 明确**不建议**改变 `voltmind init` 默认值；推迟到带 real-brain replay data 的 v0.36.x evidence pass

### Commits

```
1. feat(scripts): Phase 2 BrainBench wrapper
   - NEW: scripts/run-shootout-phase2.sh

2. data(phase2): 7 BrainBench cells
   - docs/benchmarks/2026-05-22-{cell}.md × 7

3. docs(benchmark): embedder shootout comparison writeup
   - NEW: docs/benchmarks/2026-05-22-embedder-shootout.md
   - Bootstrap p-values, HNSW footnote, NOT-in-scope section
```

### Ship
```bash
# Merge PR β to voltmind-evals main
gh pr merge --squash --auto
# Or non-auto if reviewing one more time:
gh pr merge --squash
```

### Deliverable
- PR β 已 merge 到 voltmind-evals `main`
- 对比报告公开于
  `voltmind-evals/docs/benchmarks/2026-05-22-embedder-shootout.md`

### 交接给 Session 6（可选）
- voltmind-evals master 有完整数据 + writeup
- 可以准备 voltmind v0.35.2.0 release 来 cross-link 它

---

## Session 6（可选）— PR γ: voltmind v0.35.2.0 release

**Repo:** `/Users/garrytan/conductor/workspaces/voltmind/<NEW-WORKSPACE>`（从 master 新建）
**Branch:** `garrytan/v0.35.2.0-benchmark-release`
**Wallclock:** 约 30min
**API spend:** $0

### 本 session ship 什么
一个仅 release notes 的 PR，将 voltmind bump 到 v0.35.2.0，并在 CHANGELOG 中 cross-link embedder shootout benchmark。可选；如果不急也可并入下一次常规 release。

### Prereqs
- Session 5 完成。voltmind-evals 已 merge 对比 writeup。

### Commits

```
1. docs(benchmark): mirror embedder shootout summary
   - NEW: docs/benchmarks/2026-05-22-embedder-shootout.md (slim mirror)
   - Cross-link to voltmind-evals canonical version

2. chore: v0.35.2.0
   - VERSION: 0.35.2.0
   - package.json: 0.35.2.0
   - CHANGELOG.md: new entry with the GStack-voice release summary
     + "numbers that matter" table from the benchmark
```

### Ship
```bash
/ship
```

### Deliverable
- voltmind v0.35.2.0 位于 master
- CHANGELOG entry 支撑 release-note headline

---

## Cost ledger（review 后修订）

| Component | Per cell | × 7 cells |
|---|---|---|
| LongMemEval embed | <$0.05 | <$0.35 |
| LongMemEval Sonnet answer-gen (500q × 2K tokens × $3/M) | $18 | $126 |
| LongMemEval gpt-4o judge (500q × $0.10/q) | $50 | $350 |
| BrainBench relational embed | $0.05-0.18 | <$1 |
| BrainBench Cat 13 answer-gen + judge (50q × $0.14) | $7 | $49 |
| Smoke harness (30 calls/cell) | <$0.10 | <$1 |
| **Total** | **~$75/cell** | **~$525** |

**硬上限：$700。** 单 cell 硬上限：$90（wrapper 在超出时 abort cell；partial JSONL 保留以 resume）。

## Failure modes and recovery

| Failure | Recovery |
|---|---|
| Voyage/ZE 429 rate-limit mid-cell | `gateway._shrinkState` 将 safety_factor 减半并重试。Cell 继续。 |
| ZE 5MB rerank payload cap hit | `applyReranker` fail-opens，返回未 rerank 的结果。stderr warn。 |
| Mid-cell OS interrupt / cost-cap abort | 用 `voltmind eval longmemeval --resume-from results/longmemeval-{cell}.jsonl` 重跑。从中断处继续。 |
| `evaluate_qa.py` auth fail | wrapper 中的 OPENAI_API_KEY check 会在任何花费前 abort。 |
| Adapter typo (bad dim) | `EvalAdapterConfig` runtime assertion 在 constructor 抛出 AIConfigError。Cell 在 API call 前 abort。 |

## NOT in scope（刻意不做）

- **Real `~/.voltmind` replay** — 增加 6-12h wallclock + $40-80 embed。归档到 v0.36.x。
- **全部 3 种 search modes** — 固定到 tokenmax。如果 reviewer 追问，`conservative` + `balanced` 是 v0.35.3.0 follow-up。
- **Matched-dim cross-vendor row** — 三家供应商之间不存在共同维度。永久不做。
- **`voltmind eval whoknows` / `cross-modal` / `takes-quality`** — 与 embedding 基本无关；跨 embedder rerun 只会产生噪声。
- **`voltmind eval code-retrieval`** — code corpus，另一个问题。
- **`voltmind eval suspected-contradictions`** — 需要真实 brain。
- **`voltmind init --recommended` default change** — codex 正确指出证据基础不足。推迟到带 real-brain replay data 的 v0.36.x。

## 已存在内容（复用，不重建）

- `voltmind eval longmemeval` CLI（in-tree，answer-gen mode default）
- voltmind-evals BrainBench runner（`eval:run`）— 需要 adapter parameterization，但复用 per-cell test plumbing
- Gateway routing for Voyage + ZE（v0.35.0.0 已 ship）
- Reranker pipeline（`src/core/search/rerank.ts`，fail-open）
- Pricing table（扩展，不重建）
- Paired-bootstrap methodology（`docs/eval/SEARCH_MODE_METHODOLOGY.md`）
- LongMemEval 已发布的 `evaluate_qa.py`（外部调用，不打包）
