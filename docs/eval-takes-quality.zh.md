# `voltmind eval takes-quality` — 可复现的 cross-modal quality eval

v0.32+ 发布了一个可放入 CI 的 takes layer quality gate。三个 frontier models 会按 5 维 rubric 对 takes 样本评分，runner 汇总为 PASS / FAIL / INCONCLUSIVE，并把 receipt 持久化到 `eval_takes_quality_runs`，使后续 `trend` 或 `regress` 可以与历史比较。

本文是 consumer contract。Sibling [voltmind-evals](https://github.com/garrytan/voltmind-evals) repo 和未来任何 CI gate 都会读取与下方 JSON 完全同形的 receipts。字段在 `schema_version: 1` 下 additive-stable。破坏性形状变化会 bump version。

## Subcommands

| Command | Brain required? | Exit codes |
|---|---|---|
| `voltmind eval takes-quality run [flags]` | yes（samples takes） | 0 PASS, 1 FAIL, 2 INCONCLUSIVE |
| `voltmind eval takes-quality replay <receipt>` | **no**（disk-only） | 0 PASS, 1 FAIL, 2 INCONCLUSIVE |
| `voltmind eval takes-quality trend [flags]` | yes（reads runs table） | 0 |
| `voltmind eval takes-quality regress --against <receipt>` | yes | 0 OK, 1 regression |

`replay` 是唯一不需要 `DATABASE_URL` 的模式：它从磁盘读取 receipt 文件并重新渲染。其他模式都需要 brain。

## `run` flags

| Flag | Default | Notes |
|---|---|---|
| `--limit N` | 100 | 从 brain 中随机抽样 N 条 takes。 |
| `--cycles N` | 3 (TTY) / 1 (non-TTY) | 放弃前最多 N 次 panel calls；PASS 或 INCONCLUSIVE 时 early-stop。 |
| `--budget-usd N` | unset | 如果下一次调用的预计成本会超过上限，则提前 abort。没有 `pricing.ts` 条目的 models 会 loud fail（codex #4）。 |
| `--source db|fs` | `db` | `fs` 预留给 v0.33+。 |
| `--slug-prefix P` | unset | 只抽取 slug 以 P 开头的 pages 中的 takes。 |
| `--models a,b,c` | `openai:gpt-4o,anthropic:claude-opus-4-7,google:gemini-1.5-pro` | 逗号分隔的 panel。 |
| `--json` | off | 向 stdout 输出完整 receipt。 |

## Receipt JSON shape（`schema_version: 1`）

```json
{
  "schema_version": 1,
  "ts": "2026-05-09T22:00:00.000Z",
  "rubric_version": "v1.0",
  "rubric_sha8": "abcd1234",
  "corpus": {
    "source": "db",
    "n_takes": 100,
    "slug_prefix": null,
    "corpus_sha8": "abcd1234"
  },
  "prompt_sha8": "abcd1234",
  "models_sha8": "abcd1234",
  "models": ["openai:gpt-4o", "anthropic:claude-opus-4-7", "google:gemini-1.5-pro"],
  "cycles_run": 3,
  "successes_per_cycle": [3, 3, 2],
  "verdict": "pass",
  "scores": {
    "accuracy":            { "mean": 7.8, "min": 7, "max": 9, "scores": [9,7,7], "per_model": {...} },
    "attribution":         { "mean": 7.0, "min": 7, "max": 7, "scores": [7,7,7], "per_model": {...} },
    "weight_calibration":  { "mean": 7.5, "min": 7, "max": 8, "scores": [8,7,7], "per_model": {...} },
    "kind_classification": { "mean": 7.2, "min": 7, "max": 8, "scores": [7,8,7], "per_model": {...} },
    "signal_density":      { "mean": 7.0, "min": 6, "max": 8, "scores": [8,7,6], "per_model": {...} }
  },
  "overall_score": 7.3,
  "cost_usd": 1.85,
  "improvements": ["..."],
  "errors": [],
  "verdictMessage": "PASS: every dim mean >=7 and min >=5 ..."
}
```

### Field reference

- `schema_version` — 锁定 contract。新增 optional fields 是 additive 且兼容。重命名、移除或改变语义会 bump version。
- `rubric_version` + `rubric_sha8` — 按 rubric epoch 隔离 trend rows（codex review #3）。rubric 定义变化时，两个字段都会更新，trend mode 会按此分组，避免更严格 rubric 被静默看作质量下降。
- `corpus.corpus_sha8` — 对 judge 看到的 joined takes-text 的 fingerprint。决定两次运行是否针对“同一个”样本。
- `models_sha8` — 对排序后的 model id list 的 fingerprint。`--models` 中调整顺序不会改变 sha（sort 稳定）。
- `successes_per_cycle` — 每个 cycle 中贡献模型数量。模型贡献的条件是：(a) JSON parsed，且 (b) 每个 declared rubric dim 都有 finite score（codex review #5：missing-dim 会丢弃该 contribution）。
- `verdict` — 每个 dim mean >= 7 且 contributing models 的每个 dim min >= 5 时为 `pass`；否则为 `fail`；少于 2/3 models 提供完整 scores 时为 `inconclusive`。
- `cost_usd` — 通过 `pricing.ts` 汇总每次调用成本。设置 `--budget-usd` 时，unknown models 会在任何调用发生前产生 `PricingNotFoundError`。

## Receipt persistence

Receipts 会持久化到 **`eval_takes_quality_runs`**（DB-authoritative，见 codex review #6），并 best-effort 保存到磁盘 `~/.voltmind/eval-receipts/takes-quality-<corpus>-<prompt>-<models>-<rubric>.json`。DB row 在 `receipt_json` JSONB column 中携带完整 receipt JSON，因此当磁盘 artifact 消失时，`replay` 仍可通过 `loadReceiptFromDb` 重建（v0.33+ flag wiring）。

4-sha primary key 是唯一的（`UNIQUE` constraint），因此重跑完全相同的 eval 是 `INSERT ... ON CONFLICT DO NOTHING`，具备幂等性。

## Trend output

Plain text（默认）：

```
ts                   rubric  verdict       overall  cost     corpus
─────────────────────────────────────────────────────────────────────────────
2026-05-09T22:00:00  v1.0    pass             7.3   $1.85   abcd1234
2026-05-08T18:30:00  v1.0    fail             6.8   $1.92   ef567890
```

JSON shape（`--json`）：

```json
{
  "schema_version": 1,
  "rows": [
    { "id": 42, "ts": "...", "rubric_version": "v1.0", "verdict": "pass",
      "overall_score": 7.3, "cost_usd": 1.85, "corpus_sha8": "abcd1234" }
  ]
}
```

## Regress：用质量 gate CI

```bash
# Capture a baseline.
voltmind eval takes-quality run --limit 100 --json \
  > .ci/takes-quality-baseline.json

# Later, after changing the extraction prompt:
voltmind eval takes-quality regress --against .ci/takes-quality-baseline.json \
  --threshold 0.5
# exit 0 → no regression past threshold
# exit 1 → some dim dropped > 0.5; CI fails
```

threshold 是被视作 regression 的 per-dim-mean drop。默认 0.5。Regress 会复用 prior receipt 的**同一** model panel + slug prefix + source，以便 apples-to-apples 比较。`corpus_sha8` / `prompt_sha8` / `rubric_sha8` 的差异会作为 informational warnings 暴露（runner 不拒绝，是否接受由 caller 决定）。

## Contract stability

上方形状是下游消费者的读取 contract。未列出的任何内容（例如 internal aggregator state、gateway providerMetadata）都**不**在 receipt 中，可能随时变化。

需要演进 schema 时：
1. Additive optional field → 不 bump version；旧消费者忽略新 key，新消费者读取。
2. 重命名或移除字段，或改变语义 → bump `schema_version` 到 `2`；runner 在一个 release 中同时输出两种形状，作为 deprecation runway。
