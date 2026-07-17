# Doctor Auto-Heal and Scoring Improvements

## Summary

`voltmind doctor` health score system 存在几类 false-positive 模式，并缺少 auto-heal 能力。在 crash classification fix（本 PR 已发布）之后，下面是按影响排序的剩余改进项。

---

## 1. Frontmatter severity levels

### Problem

`NESTED_QUOTES` warnings 主导了 frontmatter check（约 7,100 个总 issues 中有 6,900+ 个）。这些只是 cosmetic YAML style issues — 例如 `title: "foo"` 中引号技术上不必要。它们不影响 sync、search、embedding 或任何功能。

把它们与 `YAML_PARSE`（真实 parse failures）或 `MISSING_OPEN`（缺失 frontmatter delimiters）同等计数，会让 frontmatter check 永远处于 WARN，真正的问题被淹没。

### Evidence

```
frontmatter_integrity: 7131 issues across 3 sources
  default: 7012 (NESTED_QUOTES=6922, YAML_PARSE=90)
  media-corpus: 16 (MISSING_OPEN=15, YAML_PARSE=1)
  zion-brain: 103 (MISSING_OPEN=14, NESTED_QUOTES=89)
```

7,131 个 issues 中只有 280 个是真问题。96% 是 cosmetic noise。

### Proposed Fix

- 引入 severity levels：`error`（YAML_PARSE、MISSING_OPEN）vs `info`（NESTED_QUOTES）
- Doctor 只对 error-level issues WARN/FAIL
- 在 message text 中报告 info-level，但不影响 check status
- 可选 `--pedantic` flag 将 info-level 纳入 status

### Test Cases

| Frontmatter issues | Severity breakdown | Expected status |
|---|---|---|
| 0 issues | n/a | OK |
| 50 NESTED_QUOTES only | 0 error, 50 info | OK (with note) |
| 3 YAML_PARSE | 3 error | WARN |
| 6900 NESTED_QUOTES + 3 YAML_PARSE | 3 error, 6900 info | WARN (mentions 3 errors) |

---

## 2. Temporal contradiction awareness

### Problem

contradiction probe 会把时间演化标记为矛盾。示例：

- Page A（April）："Considering option X"
- Page B（May）："Decided on option Y"

这些不是矛盾 — 它们是同一个 topic 随时间演化。probe 没有时间意识。

### Evidence

对 50 queries、top-k=15 的 probe run：
- 检测到 120 个 contradictions（112 high，8 medium）
- 人工复核后：约 60% 是 temporal evolutions，而不是真冲突
- Pages 有可用于消歧的 `effective_date` 或 `created` timestamps

### Proposed Fix

- 将 `effective_date` / `created` 传给 judge prompt
- 增加 verdict：`temporal_supersession`（后来的 claim 取代较早 claim）
- 当两页都有日期且 claims overlap 时，偏向时间解释
- 已在 PR #993 中设计

### Test Cases

| Page A date | Page A claim | Page B date | Page B claim | Expected verdict |
|---|---|---|---|---|
| 2026-04 | "Considering X" | 2026-05 | "Chose Y" | temporal_supersession |
| 2026-04 | "Revenue is $1M" | 2026-04 | "Revenue is $500K" | contradiction |
| null | "X is true" | null | "X is false" | contradiction |
| 2025-01 | "CEO of Company" | 2026-01 | "Former CEO" | temporal_supersession |

---

## 3. Multi-source drift baseline

### Problem

由于 pre-v0.30.3 `putPage` routing bug，4,791 pages 显示 “multi-source drift”。
这些 pages 位于 `default` source，但本应在命名 source 中。修复它的
`sources rehome` 命令尚未发布。

每次 doctor run 都会为约 4,800 个没人能修的问题显示 WARN。

### Proposed Fix

允许 `doctor.baselines` config 承认已知不可修复计数：

```yaml
doctor:
  baselines:
    multi_source_drift: 4800
```

当 actual drift ≤ baseline：OK。当 drift 超过 baseline：WARN（new drift）。

也存储在 `.voltmind/doctor-baselines.json`，这样没有 config 也能工作：

```json
{
  "multi_source_drift": { "count": 4800, "acknowledged_at": "2026-05-15", "reason": "pre-v0.30.3 putPage misroutes" }
}
```

### Test Cases

| Actual drift | Baseline | Expected |
|---|---|---|
| 4791 | 4800 | OK |
| 4900 | 4800 | WARN ("100 new drift beyond baseline") |
| 4791 | 0 (no baseline) | WARN (current behavior) |

---

## 4. Image assets acknowledgment

### Problem

当 image files 从磁盘缺失（存储在外部、从 git 清理）时，检查会永久 warn。
没有办法说“这些是刻意外部化的”。

### Proposed Fix

- `doctor --acknowledge image_assets` 将当前 missing count 标记为 accepted
- 存储在 `.voltmind/doctor-baselines.json`
- 只有超过 acknowledged count 的 NEW missing images 才 WARN
- 可选 `image_assets.external_storage: true` config 完全跳过 disk check

---

## 5. Auto-heal mode

### Problem

许多 doctor warnings 有已知且安全的自动修复：

| Warning | Auto-fix |
|---|---|
| Supervisor not running | Start supervisor |
| Stale embeddings | Submit `embed --stale` job |
| Extract coverage < 70% | Submit `extract all --skip-existing` job |
| Stale sync | Submit sync job |
| Effective date drift | Run `reindex-frontmatter` |

### Proposed Fix

`doctor --auto-heal` mode：

1. Run all checks
2. For fixable WARNs: submit fix as a job (not inline — via job queue)
3. Report what was fixed vs needs manual attention
4. Idempotent: check queue first, don't submit duplicates
5. Safety gate: never auto-heals FAILs, only WARNs

Config:

```yaml
doctor:
  autoHeal:
    enabled: true
    minInterval: "6h"
    skip:
      - image_assets
      - multi_source_drift
```

### Test Cases

| Check status | Auto-heal enabled | Job already queued | Expected |
|---|---|---|---|
| WARN: stale embeds | yes | no | Submit embed job |
| WARN: stale embeds | yes | yes | Skip (idempotent) |
| FAIL: max_crashes | yes | n/a | Don't auto-fix FAILs |
| WARN: stale embeds | no | n/a | Report only |
| WARN: image_assets | yes (but skipped) | n/a | Report only |

---

## 6. Score delta tracking

### Problem

没有历史 — 每次 `doctor` run 都是一个 snapshot。无法判断分数是在改善还是恶化。

### Proposed Fix

- 将每次 run 写入 `.voltmind/doctor-history.jsonl`：
  ```json
  {"ts":"2026-05-15T12:00:00Z","score":60,"brain_score":79,"checks":{"supervisor":"ok","embeddings":"ok",...}}
  ```
- `doctor --trend` 显示最近 N 个 scores 及 deltas
- `doctor --json` 包含 `previous_score` 和 `delta` fields

---

## 7. Weighted scoring

### Problem

embed coverage 从 99% → 100% 的权重，和 50% → 51% 一样。但最后一个百分点最难（oversized pages、rate limits）。

### Proposed Fix

Threshold-based scoring:
- 100% = full points
- ≥95% = 90% of points
- ≥80% = 70% of points
- <80% = proportional

---

## Priority Order

1. Frontmatter severity levels（最高 noise reduction）
2. Temporal contradiction awareness（最高 false positive reduction，已设计）
3. Auto-heal mode（最大长期价值）
4. Score delta tracking（启用 monitoring）
5. Multi-source drift baseline（quality of life）
6. Image assets acknowledgment（quality of life）
7. Weighted scoring（nice to have）
