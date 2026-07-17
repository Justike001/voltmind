# Takes vs Facts — 架构区别

voltmind 有两个服务于不同目的的认识论存储层。**绝不要混淆它们。**

## Takes（冷存储 — `takes` table）

这是认识论层：谁在什么时间、以什么置信权重相信什么。

- **Source:** 由 LLM 分析从 brain pages（markdown）中抽取
- **Scope:** 多 holder，捕捉*任何*说话者的信念，不只限于 brain owner
- **Kinds:** `take`（观点）、`fact`（可验证事实）、`bet`（预测）、`hunch`（直觉）
- **Lifecycle:** 冷存储，回顾性。页面变化或重新抽取时更新。
- **Scale:** 成熟 brain 中跨数千 holder 的 100K+ 行

**Take 示例：**
- `holder=people/garry-tan kind=bet` "AI will replace 50% of coding by 2030" (w=0.75)
- `holder=people/jared-friedman kind=take` "Momo has strong retention" (w=0.80)
- `holder=world kind=fact` "Clipboard raised $100M Series C" (w=1.0)
- `holder=brain kind=hunch` "Garry has a hero/rescuer pattern" (w=0.70)

**Query surface:** `voltmind takes list`, `voltmind takes search`, `voltmind think`

## Facts（热记忆 — `facts` table，v0.31）

来自 brain owner 对话的个人知识。实时捕捉。

- **Source:** 由 facts hook（Haiku）逐轮从对话中抽取
- **Scope:** 单用户，只包含 brain owner 陈述过的知识
- **Kinds:** `event`, `preference`, `commitment`, `belief`, `fact`
- **Lifecycle:** 热存储，实时。随着对话发生而捕捉。
- **Bridge:** Dream cycle 的 `consolidate` phase 每晚把 hot facts → cold takes

**Fact 示例：**
- `kind=event` "I have a meeting with Brian tomorrow"
- `kind=preference` "I don't drink coffee"
- `kind=commitment` "We decided on nesting custody"
- `kind=belief` "I think the market is overheated"

**Query surface:** `voltmind recall`, MCP `_meta.brain_hot_memory`

## Category Error

**绝不要把 takes 直接倒进 facts table。** Takes 包含他人的归因信念（Jared 对某公司的判断、PG 对学校的看法、创始人的收入主张）。这些不是 brain owner 的个人事实。

**也绝不要未经转换就把 facts 倒进 takes table。** Facts 的范围是 owner 在对话中说过什么。它们只能通过 dream cycle 的 consolidate phase 变成 takes，该阶段会添加正确归因、去重和时间推理。

## The Bridge

Dream cycle 的 `consolidate` phase（v0.31）是单向桥梁：

```
hot facts → [dream consolidate] → cold takes
```

Facts 只朝一个方向流动。consolidate phase 会：
1. 按实体分组相关 facts
2. 与现有 takes 去重
3. 用正确 holder/weight 把持久 facts 提升为 takes
4. 用 `consolidated_at` + `consolidated_into` 标记已合并 facts

## Production Extraction Data（2026-05-10）

在约 100K-page brain 上第一次完整 takes 抽取：
- **Model:** Azure GPT-5.5（质量与 Opus 持平，成本为 1/8 — $0.033 vs $0.260/page）
- **Result:** 从 28,256 个磁盘页面抽取 100,720 条 takes，成本 $361.49，83 个错误（0.3%）
- **Breakdown:** 70,960 takes / 24,342 facts / 2,875 bets / 2,649 hunches
- **Holders:** 6,239 个唯一 holders
- **Cross-modal eval:** 总体 6.8/10（GPT-5.5 + Opus 4.6 独立评分）

### Eval Dimensions

| Dimension | Score | Notes |
|-----------|-------|-------|
| Accuracy | 7.5 | Claims faithfully represent sources |
| Attribution | 6.5 | Holder/subject confusion was #1 issue |
| Weight calibration | 7.0 | Good range usage, some false precision |
| Kind classification | 6.5 | Occasional fact/take misclassification |
| Signal density | 6.5 | Some trivial extractions pass through |

### 抽取 prompt 的关键经验

1. **Holder ≠ subject.** "Garry has a hero/rescuer pattern" → holder=brain，而不是 people/garry-tan
2. **Atomic claims.** 把复合主张拆成独立行
3. **Amplification ≠ endorsement.** 只转发 → 最大 weight 0.55
4. **Self-reported ≠ verified.** "Reports 7 figures" → holder=person, weight=0.75，而不是 world/1.0
5. **No false precision.** 使用 0.05 递增（0.35、0.55、0.75），不要用 0.74 或 0.82
6. **"So what" test.** 跳过 Twitter handles、粉丝数、明显 metadata
