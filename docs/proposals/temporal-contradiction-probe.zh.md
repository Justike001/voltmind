# Proposal: Temporal Axis for Contradiction Probe

**Status:** Report / RFC
**Date:** 2026-05-14
**Context:** 一次大规模 production run 的 `voltmind eval suspected-contradictions`
暴露了约 115 个 HIGH findings。逐一人工查看后，发现 probe 中存在一个结构性限制。

## The Problem

contradiction probe（`voltmind eval suspected-contradictions`）把所有 claims
都当作无时间属性。当两个 chunks 做出冲突陈述时，无论两条陈述在各自时间点是否都为真，
judge 都会标记 contradiction。

当 brain 主要是静态 wiki pages 时，这没问题。但现在 brain 包含：
- Conversation transcripts，其中的 claims 在说出口时为真
- Meeting pages，记录人们在特定日期说过的话
- 会演化的 takes（founder 一月的 ARR claim vs 七月的 claim）
- 相互 supersede 的 status records（状态从 “trial” 到 “confirmed”）

probe 无法区分 “this changed” 和 “this is wrong”。

## Bug-class examples (synthetic placeholders)

### 1. Temporal Evolution (False Positive)

```
Finding: HIGH
  A: [daily/transcripts/2026/2026-04-28] "status: trial"
  B: [meetings/2026-05-07-session] "status: confirmed"
  Axis: Whether status is trial or confirmed
```

两者在各自日期都是正确的。4 月 28 日：trial。5 月 7 日：confirmed。
probe 标记它，是因为它没有 “this claim was valid from X until Y” 的概念。
5 月 7 日的记录并没有让 4 月 28 日的 transcript 变错；它记录的是变化。

### 2. Negation Parsing (False Positive)

```
Finding: HIGH
  A: [people/alice-example] "person traveled to city-a for alice-example's event — NOT bob-example's event"
  B: [meetings/2026-05-11-context] mentions of bob-example's event in city-b
  Axis: Whose event the city-a trip was for
```

disambiguation fact 中有 “NOT bob-example's event” 作为显式否定。judge
把 “bob-example's event” 读成了正向 claim，并将其与 alice-example context
对立起来。数据是正确的；probe 不会解析否定。

### 3. Role Changes (True Positive That Needs Time Awareness)

```
Finding: HIGH
  A: [sources/notes/2017-03-28] advisor-example: "Partner, venture-firm-a"
  B: [people/advisor-example] advisor-example: "Senior Policy Advisor, gov-org-b"
```

两者在各自时间都为真。2017：venture-firm-a partner。2025：gov-org-b advisor。
当前 probe 正确地将其标为 contradiction，但 resolution 应该是 “superseded by time”，
而不是 “一边是错的”。2017 年的 note 不是错的；它是历史记录。

## Scenario #1: Founder Tracking (the big one)

这是让时间轴变得 transformative、而不仅是 incremental 的用例。

brain 持有数百个 company pages 和数千个 meeting pages。Founders 会做 claims：

- "We're at $50K MRR"（January OH）
- "We hit $200K MRR"（April OH）
- "We're at $150K MRR"（July OH — what happened?）

今天 probe 会把 January vs. April 标为矛盾。真正的信号是 April vs. July：
**一个声称的 metric 倒退了。** 这不是数据质量问题；这是 intelligence。

time-aware probe 可以暴露：

**Claim trajectory tracking:**
```
Company: Acme Corp
  2026-01: "$50K MRR" (source: OH transcript)
  2026-04: "$200K MRR" (source: OH transcript)
  2026-07: "$150K MRR" (source: OH transcript) ← REGRESSION DETECTED
  2026-07: "$2M ARR" (source: investor update) ← INCONSISTENT WITH MRR
```

**Prediction vs. outcome:**
```
Founder: Jane Doe (Acme Corp)
  2026-01: "We'll hit $1M ARR by June" (source: batch kickoff)
  2026-06: Actual ARR: $400K (source: investor update)
  → Prediction accuracy: 40%
  → Pattern: consistently 2-3x optimistic on timeline
```

**Narrative consistency:**
```
Founder: John Smith (WidgetCo)
  2026-01: "Our moat is proprietary data" (source: interview)
  2026-03: "We're pivoting to an API-first model" (source: OH)
  2026-06: "Our moat is network effects" (source: Demo Day)
  → Moat narrative changed 3x in 6 months — flag for review
```

这不是 adversarial。这是有经验的 operator 会在数百次对话中直觉注意到的模式。
VoltMind 可以让它系统化。

## Scenario #2: Event Disambiguation

短时间窗口内的两个不同事件可能在 ingestion 中被混淆，因为 probe 没有时间框架来说
“event A 和 event B 是不同事件”。

Time-aware facts 会存储（synthetic placeholders）：
```
fact: "alice-example milestone" valid_from: 2026-04-15 valid_until: 2026-04-15
fact: "alice-example event in city-a" valid_from: 2026-04-17 valid_until: 2026-04-19
fact: "bob-example milestone" valid_from: 2026-05-04 valid_until: 2026-05-04
fact: "bob-example event in city-b" valid_from: 2026-05-12 valid_until: 2026-05-12
```

probe 应该识别出这些是时间窗口不重叠的两个不同事件，而不是关于“谁的 event”的矛盾。

## Scenario #3: Role and Status Changes

人会换角色。公司会换状态。brain 记录历史。以下 synthetic examples 代表 production
中观察到的 cases：

- advisor-example: venture-firm-a partner (2019) → gov-org-b advisor (2025)
- investor-example: fund-a partner → fund-b CEO (2023)
- agent-fork: provider restriction event (2026-04-04) ≠ shutdown
- fund-c: "interesting fund" (early) → "declined" (later) → "losing confidence" (latest)

这些都是正确的历史记录。probe 应该把它们分类为 **temporal supersession**，
而不是 **contradiction.**

## Scenario #4: Decision Tracking

多步骤决策会 supersede 早期 framing 的示例（synthetic）：
```
2026-04-24: "status: trial" (initial framing)
2026-04-25: "status: in progress" (confirmed, no longer "trial")
2026-05-07: "status: finalized" (session record)
2026-05-11: follow-up actions taken
```

每一步都 supersede 前一步。time-aware probe 会展示 **evolution chain**，
而不是把每一对都标为 contradiction。

## What Exists Today

probe 已经有一些 temporal infrastructure：

1. **`date-filter.ts`** — `shouldSkipForDateMismatch()` 会预过滤 pairs，
   但只检查日期是否“相距太远”（粗粒度 heuristic）。它不会推理哪个 claim 更新，
   或者一个是否 supersede 另一个。

2. **`auto-supersession.ts`** — 提出 resolution commands，检查 takes 上的
   `since_date`。但这是 post-hoc（judge 标记 contradiction 之后）。
   judge 本身看不到 dates。

3. **Facts table** 有 `valid_from` 和 `valid_until` columns。它们存在，
   但填充稀疏，且未被 probe 使用。

4. **Takes table** 有 `since_date`。同样填充稀疏。

## What Would Need to Change

### Phase 1: Judge prompt enhancement (smallest change, biggest impact)

把 source dates 传给 judge。当前 judge prompt 展示两个 text chunks，并询问
“are these contradictory?” 如果它同时展示：

```
Statement A (from: 2026-04-28):
  "status: trial"

Statement B (from: 2026-05-07):
  "status: confirmed"
```

judge 就可以输出 `temporal_supersession` verdict，而不是 `contradiction`。
新的 verdict taxonomy：

- `no_contradiction` — statements are compatible
- `contradiction` — genuinely conflicting claims at the same point in time
- `temporal_supersession` — newer claim updates/replaces older claim (not an error)
- `temporal_regression` — a metric or status went backwards (potential signal)
- `temporal_evolution` — legitimate change over time, neither supersession nor regression
- `negation_artifact` — one side contains an explicit negation the judge misread

### Phase 2: Claim trajectory view (new command)

```bash
voltmind eval trajectory "Acme Corp MRR"
voltmind eval trajectory "advisor-example role"
voltmind eval trajectory "deal-x status"
```

拉取关于 entity+attribute 的所有带时间戳 claims，按时间排序，检测：
- Regressions（metric 下降）
- 同一时间窗口内的 contradictions
- Prediction vs. outcome gaps
- Narrative drift（moat story changed 3x）

### Phase 3: Automatic `valid_from`/`valid_until` population

在 `extract_facts` 期间，从 source context 推断 temporal bounds：
- Meeting page dated 2026-04-28 → claims valid_from 2026-04-28
- Takes from transcripts → valid_from = transcript date
- Imported notes → valid_from = note date
- Entity pages with no date → valid_from = page created date（最弱信号）

### Phase 4: Founder scorecard

特别对于 founders，temporal probe 可以生成：
- **Claim accuracy score** — 他们预测了什么 vs 实际发生了什么
- **Consistency score** — narrative 随时间有多稳定
- **Growth trajectory** — numbers 是否真的在动
- **Red flag detector** — metrics 倒退、故事变化、timeline slipping

## Recommendation

从 Phase 1 开始。judge prompt change 很小。它能立即消除 temporal false positives
（production audit 中残余 HIGH findings 的多数），并给 probe 一个新的 time-aware
reasoning 词汇表。

Phase 2（trajectory view）会改变 operators 如何用 brain 做 founder evaluation。
值得作为独立 feature 进行 scope。

Phases 3–4 是 downstream，可以等待。

## Appendix: Production probe stats (2026-05-14)

- ~107K pages, ~257K chunks
- Previous run: ~115 HIGH findings across 50 queries
- After manual resolution: ~25 residual findings
- Of those ~25: roughly two-thirds temporal false positives, the remainder probe artifacts (self-contradiction, negation parsing)
- 0 genuine data contradictions remained on the queries tested
- Fresh targeted probe on a representative entity-role query: 0 contradictions (was 14+ before fixes)
