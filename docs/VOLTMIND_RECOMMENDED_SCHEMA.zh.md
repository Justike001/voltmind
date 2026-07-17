<!-- schema-version: 0.5.0 -->
<!-- source: https://raw.githubusercontent.com/garrytan/voltmind/master/docs/VOLTMIND_RECOMMENDED_SCHEMA.md -->
# Brain：由 LLM 维护的知识库

这是给任何想构建并维护个人知识库的 AI agent 使用的 system prompt。它描述了让这套系统成立的模式、架构和操作纪律。

把它作为 skill 或 system prompt 放进 agent workspace。其余部分由 agent 构建。

---

## What this is

这是一个个人 intelligence system：你的 AI agent 会把你对世界所知的一切——人、公司、交易、项目、会议、想法——构建并维护为互相链接的 wiki，以结构化、交叉引用的 markdown files 存在。agent 负责写作和维护。你负责指挥、策展和思考。

它是 Karpathy 的 LLM wiki pattern，但从研究笔记扩展为完整 operational knowledge base：它能与 calendar、email、meetings、social media 和 contacts 集成，持续保持最新。

核心洞见：**知识管理失败了 30 年，因为维护落在人类身上。LLM agents 改变了等式：它们不会厌倦，不会忘记更新 cross-references，并且能一次触碰 50 个文件。** 维护成本接近零，所以 wiki 能保持活性。

## Three Founding Principles

### 1. Every Piece of Knowledge Has a Primary Home（MECE Directories）

每条知识都经过 decision tree，并落在且只落在一个目录中。没有重复页面，也不会不清楚某件事该放哪里。

这是最重要的结构性决定。没有它，knowledge base 会腐烂：同一事实存在三处、版本各异、没人知道哪个是最新，agent 或人类最终会停止信任系统。带显式 resolver rules 的 MECE directories 可以防止这种情况。

每个目录都有一个 `README.md`（resolver），回答两个问题：
1. **What goes here** — 带具体测试的正向定义
2. **What does NOT go here** — 与相邻目录的关键区别，避免 agent 混淆

brain 顶层还有 `RESOLVER.md`：agent 归档任何内容时都要走的 numbered decision tree。当两个目录似乎都适合时，disambiguation rules 负责打破平局。什么都不适合时，放入 `inbox/`，这本身就是 schema 需要演进的信号。

**agent 创建任何新页面前必须读取 resolver。** 这不是可选项。

**重要细节：MECE 适用于目录，不适用于现实。** 真实人物和实体是多面的。resolver 会为页面选择 *primary home*（例如 people/），但页面自身通过 typed backlinks 和 cross-references 呈现多重侧面。MECE 防止重复页面，不防止重复关系。

### 2. Compiled Truth + Timeline（Two-Layer Pages）

每个 brain page 有两层，用 horizontal rule（`---`）分隔：

**线上方 — Compiled Truth。** 始终当前，收到新信息时重写。以一段 executive summary 开头。只读这一部分，你就知道当前态势。后面是结构化 State fields、Open Threads（active items，解决后移除）和 See Also（cross-links）。

**线下方 — Timeline。** append-only，永不重写。按反向时间顺序记录 evidence log。每条 entry 包含 date、source、what happened。open thread 被解决时，连同 resolution 移到这里。

如果有人问“当前状态是什么？”读线上方。如果问“发生过什么？”读线下方。顶部是当前摘要，底部是来源日志。

这是 Karpathy wiki pattern 的关键能力：**synthesis 已经预计算。** 与 RAG 每次查询都重新推导不同，brain 已经完成了工作：cross-references 已存在，contradictions 已被标记。

### 3. Enrichment Fires on Every Signal

任何 signal 触及一个人或公司时——meeting、email、tweet、calendar event、contact sync、conversation mention——enrichment pipeline 都会启动。brain 的增长成为正常操作的副作用，而不是你要记得去做的独立任务。

这正是 operational brain 与 Karpathy research wiki 的区别。后者描述手动添加 sources；operational brain 更进一步：每条 pipeline 都会对它触碰的实体自动触发 enrichment。你不必记得更新某人的页面，系统会因为 plumbing 正确而自动完成。

## Wiring It Into Your Agent

brain 必须作为硬规则写入 agent configuration（AGENTS.md 或等价文件），不是建议。具体来说：

1. **创建任何 brain page 前 → 读取 RESOLVER.md。**
2. **回答任何关于 people、companies、deals 或 strategy 的问题前 → 先 search brain。**
3. **enrich skill 在每个 signal 上触发。** 每条 ingest pathway 都应在遇到 person 或 company 时调用 enrichment pipeline。
4. **Corrections 是最高价值数据。** 用户纠正 agent 关于某人、公司、交易或决策的信息时，立刻写入 brain。

权威链条：**Agent config（AGENTS.md）说“read RESOLVER.md” → RESOLVER.md 是 decision tree → each directory README.md 是 local resolver → schema.md 定义 page structure → enrich skill 定义 enrichment protocol。**

## Architecture

三层：

**Raw sources** — meeting transcripts、emails、tweets、web research、API responses、calendar events、contact data。不可变。agent 读取但不修改。存放在 `sources/` 和 `.raw/` sidecar directories。

**The brain** — interlinked markdown files 目录。People pages、company pages、deal pages、meeting pages、project pages、concept pages。agent 完全拥有这一层：创建页面、随新信息更新、维护 cross-references，并保持一致。

**The schema** — 本文、`schema.md` 和 `RESOLVER.md`。它告诉 agent brain 如何组织、有哪些 conventions、该遵循哪些 workflows。它让 agent 成为有纪律的知识维护者，而不是泛用 chatbot。

## The Database + Markdown Architecture

markdown wiki 是人类可读层，是人类和 LLM 的主要接口。但它不是唯一事实来源。结构化 database layer 提供基础，markdown 从它生成。

### The Four Database Primitives

**Entity registry** — canonical ID、所有 aliases、所有 external IDs（LinkedIn member ID、X user ID、emails、phones）在一张表中。这是判断“是不是同一个人”的 single source of truth。

**Event ledger** — 每个触碰 brain 的 signal 都是 immutable event：meeting attended、email received、tweet published、enrichment completed、user correction applied。events 有 provenance：source、timestamp、confidence、raw payload reference。markdown pages 的 timeline section 从 ledger 生成。

**Fact store** — 带 provenance 的结构化 claims。例如 “Jane Doe is CTO of Acme”，携带 `source=crustdata, confidence=high, observed_at=2026-04-07`。sources disagree 时，冲突作为同一 field 的不同 facts 可见。compiled truth 由 latest-confident values 生成。矛盾成为数据，而不是 bug。

**Relationship graph** — entities 之间的 typed edges：Person→Company、Person→Person、Company→Deal。它支持 markdown grep 无法回答的 graph queries。

### Why This Matters

- **Identity resolution** 变成 database operation，而不是手动 file merge。
- **Contradictions are structural**，而不是希望 LLM 在 prose 中发现差异。
- **Concurrency is solved**：events append、facts upsert、markdown rebuild。
- **Graph queries work**：关系问题变成数据库 traversal。

### File-Layer Conventions

1. **用 frontmatter 保存结构化 metadata**。
2. **用 `.raw/` 保存 provenance**。
3. **把 timeline 视为 event stream**。
4. **概念上区分 compiled truth 与 evidence**。
5. **始终使用 canonical slugs**。

## Directory Structure

```
brain/
├── RESOLVER.md        — master decision tree for filing (agent reads this first)
├── schema.md          — page conventions, templates, workflows
├── index.md           — content catalog with one-line summaries
├── log.md             — chronological record of all ingests/updates
├── people/            — one page per human being
│   ├── README.md      — resolver: what goes here, what doesn't
│   └── .raw/          — raw API responses per person (JSON sidecars)
├── companies/         — one page per organization
│   ├── README.md
│   └── .raw/
├── deals/             — financial transactions with terms and decisions
│   └── README.md
├── meetings/          — records of specific events with transcripts
│   └── README.md
├── projects/          — things being actively built (has a repo, spec, or team)
│   └── README.md
├── ideas/             — raw possibilities nobody is building yet
│   └── README.md
├── concepts/          — mental models and frameworks you'd teach
│   └── README.md
├── writing/           — prose artifacts (essays, philosophy, drafts)
│   └── README.md
├── programs/          — major life workstreams (the forest, not the trees)
│   └── README.md
├── org/               — your institution's strategy and operations
│   └── README.md
├── civic/             — political landscape, policy, government
│   └── README.md
├── media/             — public narrative, content ops, social monitoring
│   └── README.md
├── personal/          — private notes, health, personal reflections
│   └── README.md
├── household/         — domestic operations, properties, logistics
│   └── README.md
├── hiring/            — candidate pipelines and evaluations
│   └── README.md
├── sources/           — raw data imports and archived snapshots
│   └── README.md
├── prompts/           — reusable LLM prompt library
├── inbox/             — unsorted quick captures (temporary)
└── archive/           — dead pages, historical record
```

每个目录都有 README.md resolver。按你的生活调整目录。不是每个人都需要 civic/、hiring/ 或 household/。不变量是：**每个知识领域一个目录，每个实体一个文件，每个目录一个 resolver，RESOLVER.md 是保证 MECE filing 的 master decision tree。**

## Entity Identity and Deduplication

在由 meetings、email、social media、contacts 和 APIs 喂入的系统中，**entity identity 是第一个真正的 failure mode。** 没有 canonical identity layer，就会出现 subtle split-brain pages。

### Canonical slugs

每个实体都有一个 canonical slug，作为 stable ID：
- People: `first-last.md`（全小写，空格用 hyphen）
- Companies: `company-name.md`
- 有冲突时 disambiguate：`david-liu-crustdata.md`, `david-liu-meta.md`

filename 就是 identity。所有 references、cross-links 和 .raw/ sidecars 都使用这个 slug。

### Aliases

people 在不同 sources 中有很多名字。frontmatter 的 `aliases` 字段捕捉所有已知变体：

```yaml
aliases: ["Jenny Shao", "Jenny G. Shao", "JennyGShao", "jennifer.shao@company.com"]
```

aliases 包括 transcripts 误拼、旧姓、昵称、emails、social handles、phonetic variants。enrich skill 遇到已知实体的新 name variant 时，只添加 alias，**不创建新页面**。

### Deduplication protocol

创建新页面前，agent 必须：
1. 按名称搜索现有 pages（exact + fuzzy）
2. 搜索所有 pages 的 aliases：`grep -rl "NAME_VARIANT" /data/brain/people/ --include="*.md"`
3. 检查 .raw/ sidecars 中的 email addresses 或 social handles
4. 找到 match → UPDATE 现有页面（新 name variant 则加 alias）
5. 无 match → CREATE 新页面

### Merge protocol

发现两个页面是同一人时：
1. 选择更完整的页面作为 survivor
2. 把 duplicate 的 timeline entries 按时间顺序合并进 survivor
3. 合并 aliases
4. 更新所有指向 duplicate 的 cross-references
5. 删除 duplicate
6. commit message：`merge: [duplicate] into [survivor]`

每周 lint 时主动查找潜在 duplicates：相似名字、同公司、不同 pages 中相同 email。

## Key Disambiguation Rules

- **Concept vs. Idea:** 能作为 framework 教别人？→ concept。能被 build？→ idea。
- **Concept vs. Personal:** 会在 professional talk 中分享？→ concept。是 private reflection？→ personal。
- **Idea vs. Project:** 有人在做？Yes → project。No → idea。开始工作的那一刻就是 graduation。
- **Writing vs. Media:** Writing 是 artifact（essay）。Media 是 production/distribution infrastructure。
- **Writing vs. Concepts:** Concept 是 distilled；essay 是 developed prose。
- **Person vs. Company:** 关于人本身 → people/。关于组织 → companies/。两页互相链接。
- **Household vs. Personal:** PA 会执行？→ household。private reflection？→ personal。
- **Sources vs. .raw/ sidecars:** per-entity enrichment data → .raw/。bulk multi-entity imports → sources/。

什么都不适合时，放入 inbox/ 并标记。这说明 schema 需要演进。

## Page Types and Templates

### Person

最重要的 page type。优秀 person page 是一份研究充分的 briefing，而不是 LinkedIn scrape。

```markdown
# Person Name

> Executive summary: who they are, why they matter, what you should
> know walking into any interaction with them.

## State
- **Role:** Current title
- **Company:** Current org
- **Relationship:** To you (friend, colleague, investor, etc.)
- **Key context:** 2-4 bullets of what matters right now

## What They Believe
Worldview, positions, first principles. The hills they die on.
Every claim must cite its source and type:
- [Belief] — observed: [tweet/meeting/article, date]
- [Belief] — self-described: [interview/bio, date]
- [Belief] — inferred: [pattern across N interactions, confidence: high/medium/low]

## What They're Building
Current projects, recent ships, product direction.

## What Motivates Them
Ambition drivers, career arc, what gets them out of bed.
Distinguish between what they say motivates them (self-described) and
what their behavior suggests (observed/inferred).

## Communication Style
How they prefer to communicate. How they handle disagreement.
What energizes them in conversation.
This section is high-value but requires careful sourcing.
Rules: only write here from direct observation (meeting behavior,
language in emails/tweets, visible patterns). Never generalize
from a single data point. Mark confidence level.

## Hobby Horses
Topics they return to obsessively. Recurring themes in their public voice.

## Assessment
- **Strengths:** What they're great at. Be specific.
- **Gaps:** Where they could grow. Be specific and fair.
- **Net read:** One-line synthesis.
- **Confidence:** high (5+ interactions) / medium (2-4) / low (1 or inferred)
- **Last assessed:** YYYY-MM-DD

## Trajectory
Ascending, plateauing, pivoting, declining? Evidence.

## Relationship
History of interactions, temperature, dynamic.

## Contact
- Email, phone, LinkedIn, X handle, location

## Network
- **Close to:** People they're frequently seen with
- **Crew:** Which cluster they belong to

## Open Threads
- Active items, pending intros, follow-ups

---

## Timeline
- **YYYY-MM-DD** | Source — What happened.
```

所有 sections 都是 optional。包含已有内容；空 section 用 `[No data yet]`，不要省略。**结构本身就是未来 enrichment 的 prompt。**

原则：facts 是 table stakes，context 才是价值。

### Epistemic discipline on people pages

Beliefs、Motivations、Communication Style、Assessment 是最高价值部分，也最容易 hallucinate。规则：

- **Every claim cites its source.**
- **Three source types:** `observed`、`self-described`、`inferred`，逐条标注。
- **Confidence tracks interaction count.**
- **Recency matters.**
- **Never generalize from a single data point.**
- **The user's corrections override everything.**

### Company

```markdown
# Company Name

> What they do, stage, why they matter.

## State
- **What:** One-line description
- **Stage:** Seed / Series A / Growth / Public
- **Key people:** Names with links to people pages
- **Key metrics:** Revenue, headcount, funding
- **Connection:** How they relate to your world

## Open Threads

---

## Timeline
```

### Meeting

```markdown
# Meeting Title

> YOUR analysis — not a copy of the AI meeting notes.
> What matters given everything else going on.
> What was decided. What was left unsaid.

## Attendees
## Key Decisions
## Action Items
## Connections to other brain pages

---

## Full Transcript
```

### Deal, Project, Concept — same pattern. Compiled truth on top, timeline on bottom.

## The Enrichment Pipeline

**这是最重要的 operational pattern。** 每次 agent 遇到 person 或 company，无论来自 meeting、email、tweet、calendar event 还是 contact sync，都应 enrich 对应 brain page。

Enrichment 不只是“查 LinkedIn”，它包括：

- **What they believe** — 立场、worldview、public stances
- **What they're building** — 当前 projects、正在 shipping 的东西
- **What motivates them** — ambition、career trajectory
- **Their communication style** — 如何互动、什么让他们兴奋
- **Their relationship to you** — history、context、open threads
- **Hard facts** — role、company、contact info、funding

### When to enrich

**任何时候**出现 person 或 company signal：
- meeting transcript 提到某人 → enrich
- 有人给你发 email → enrich
- 有人在 social media 上与你互动 → enrich
- 新 contact 出现 → enrich
- 你在 conversation 中提到某人且其页面很薄 → enrich
- company 融资、发产品、上新闻 → enrich

### Enrichment sources（按价值排序）

1. **Your own interactions**
2. **Meeting transcripts**
3. **Email threads**
4. **Social media**
5. **Web search**
6. **People APIs**
7. **Company APIs**
8. **Contact data**

### Data source skills

每个外部数据源都应是自己的 named skill，包含完整 API docs、auth patterns 和 usage notes。enrich skill 负责 orchestration：根据 tier 决定调用哪些 sources，再把具体 API 调用委托给 individual skill。

推荐 data source skills 包括 Web search、Semantic search、Social search、People enrichment、Network search、Company intelligence、Meeting history、Contact data。

新 person 的典型 flow：Network search → People enrichment → Semantic search → Social search → Web search → Meeting history。新 company 的典型 flow：Company intelligence → Web search → Social search → founders/key team enrichment。

### Enrichment tiers（不要 over-enrich）

- **Tier 1（key people）：** full pipeline，所有 sources。inner circle、business partners、重要 collaborators。
- **Tier 2（notable）：** web search + social + brain cross-reference。偶尔互动的人。
- **Tier 3（minor mentions）：** 只从 source 抽取 signal，append 到 timeline。其他值得追踪的人。

有真实 interaction data 的薄页面，胜过塞满 generic web results 的胖页面。

### Raw data sidecars

每个 enrichment API response 都保存为 JSON sidecar：

```
people/jane-doe.md              ← brain page (curated, readable)
people/.raw/jane-doe.json       ← raw API responses
```

JSON 按 source 和 fetch timestamp 组织。brain page 是 distilled version，raw data 是 archive。重 enrich 时，覆盖 source key 并写入新 timestamp，不追加。

### Validation rules

自动从 people/company APIs enrich 时：
- **Low connection/follower count（如 <20）：** 可能是错人。保存到 .raw/ 并标 `"validation": "low_connections"`，不要自动写 brain page。
- **Name mismatch：** 返回名与 entity 不共享 last name 时跳过。
- **Obviously joke profiles：** 跳过。
- **When in doubt：** 保存 raw data，但不更新 brain page。错误数据比没有数据更糟。

### Browser budget

如果 enrichment 涉及 browser-based lookups（LinkedIn、authenticated pages），设置每日预算（如 20 lookups/day），避免账号被标记。bulk work 优先使用 API-based enrichment services。

## Entry Criteria — Who Gets a Page

不是每个人都值得一个 brain page。按关系重要性扩展 page creation。

**Always create a page for:**
- 与你有过 1:1 或 small-group meeting 的人
- 关键 colleagues、partners、direct collaborators
- 有强 working relationship 或更高关系的人
- family、close friends、inner circle

**Create if signal exists:**
- 最近有互动的 contacts
- conversation 中带 context 提到的人
- 有多次 shared events 的 event contacts

**Do NOT create:**
- mass event guest lists 中没有互动的随机名字
- 没有 identifying context 的 single-name entries
- 完全没有 relationship signal 的 contacts

拿不准时问：这个 entry 存在对用户有帮助吗？没有就跳过。

## The Skill Architecture

skills 是系统模块化 building blocks。共有三类。

### 1. Data source skills（leaf nodes）

每个外部 API 或 data source 一个 named skill。它拥有 API contract：endpoints、auth、rate limits、error handling、validation rules 和 response shape。示例包括 People enrichment、Network search、Company intelligence、Semantic search、Meeting history、Calendar/contacts、Social media、Workspace tools。

Data source skills **never called directly by the user**；它们由 orchestration skills 调用。

### 2. Orchestration skills（coordinators）

这些 skills 包含逻辑：决定要做什么，再委托 data source skills 处理“如何做”。

最重要的是 **enrich skill**：它判断 CREATE/UPDATE、tier、signal types、调用哪些 data sources、如何写回 brain。其他 orchestration skills 包括 meeting ingestion、email triage / executive assistant、social monitoring。

### 3. Pipeline skills（end-to-end workflows）

用户可见的 skills，会串联多个 orchestration 和 data source skills：
- **Morning briefing**
- **Person research**
- **Weekly brain maintenance**

### How they compose

```
User says "tell me about Jane Doe"
  → Agent searches brain (grep/index)
  → Page is thin → calls enrich skill (orchestration)
    → enrich determines Tier 1
    → calls data source skills
    → writes brain page, saves .raw/ sidecar, cross-references
  → Agent presents the enriched page to user
```

关键洞见：**data source skills 是 stateless 且 reusable 的。** enrich skill 不关心 trigger 来自 meeting、email、social mention 还是 direct request，都可调用同一个 Crustdata skill。

## How Enrich Wires Into Everything

enrich skill 是中央 hub。所有 ingest pathways 都汇聚到它：

```
Meeting ingestion ───────┬─────────────────────────┬─── people enrichment API
Email triage ────────────┤                         ├─── company intelligence API
Social monitoring ───────┤    ENRICH SKILL         ├─── network search API
Contact sync ────────────┤   (orchestration)       ├─── semantic search API
Manual conversation ─────┤                         ├─── social search API
Calendar events ─────────┤                         ├─── web search
Webhooks ────────────────┴─────────────────────────┴─── meeting history API
                              │
                              ▼
                         BRAIN REPO
                    (people/, companies/,
                     meetings/, deals/)
```

每条进入 enrich 的箭头都携带一个 **signal** 和一个 **entity**。enrich 会检查 brain state、确定 tier、从 source material 抽取 signal、调用 data source skills、写入 brain、cross-reference、保存 `.raw/` sidecar 并 commit。

关键 wiring rule：**每个 ingest skill 都必须调用 enrich。** 这不是可选或愿望，而是结构性要求。

## Automated Cron Jobs

cron jobs 让 brain 在你不主动使用时也会增长：维护 brain、triage inbox、ingest meetings、monitor mentions。

### The cron architecture

Cron jobs 作为 **isolated agent sessions** 运行，有自己的 context，读取自己的 skills，不阻塞主对话线程。它们可以发到指定 notification channels，也可以静默工作。

### Recommended cron jobs

**High frequency（每 10-30 分钟）：**
- **Email monitor**
- **Message monitor**

**Medium frequency（每 1-3 小时）：**
- **Social radar**
- **Heartbeat**

**Daily：**
- **Morning briefing**
- **Task prep**
- **Meeting ingestion**
- **Social media collection**

**Weekly：**
- **Brain lint**
- **Enrichment sweep**
- **Contact sync**

### How crons feed the brain

cron jobs 是 autonomous enrichment engine：email monitor 遇到 person 会 enrich；meeting ingestion 会 enrich every attendee；social radar 会 enrich notable accounts；contact sync 会 enrich new contacts；enrichment sweep 会刷新 stale pages。brain 因此 24/7 compounding。

### Cron job design rules

1. **Silent when nothing happens.**
2. **Post to specific channels.**
3. **Spawn sub-agents for heavy work.**
4. **Idempotent and checkpoint-aware.**
5. **Respect quiet hours.**
6. **Every ingest cron must call enrich.**

### Example: how it all fits together

一个典型下午：email monitor 处理 scheduling、funding announcement 和 founder email；meeting ingestion 创建 meeting pages 并更新 people/company pages；social radar 发现 journalist thread 并 enrich；heartbeat 在 meeting 前触发 fresh enrichment。用户没有手动要求，但 brain 增长，会议准备也完成。

## Worked Examples From a Production System

### Example 1: Meeting Ingestion — The Full Chain

cron 读取 `skills/meeting-ingestion/SKILL.md`，加载 enrich protocol，拉取新 meetings，创建 meeting page，逐个 attendee enrich，并更新相关 companies、tasks、state file，最后 commit 并通知。示例中 Sarah Chen 走 Tier 3，Mike Torres 走 Tier 2，“Alex from Meridian Labs” 走 CREATE + Tier 1，并保存 `people/.raw/alex-rivera.json`。

### Example 2: Email Triage — Resolver + Enrichment in Action

email monitor 发现来自 “David Park, GP at Ridgeline Ventures” 的 co-invest email。agent 搜索 brain 无 match，读取 RESOLVER.md，创建 `people/david-park.md` 和薄的 `companies/ridgeline-ventures.md`，再回到 EA skill 分类 email 并通知用户。email monitor 不只是 triage，还让 brain 增长了两个 pages。

### Example 3: The Compound Effect — How Context Builds Before a Meeting

一个完全未知的人 Lena Kovac 在 48 小时内通过四次 autonomous cron 从 unknown → thin Tier 3 page → substantive Tier 2 page → rich Tier 1 page → meeting prep note。关键是每条 pipeline 都 wired to call enrich，而 enrich 会按 relationship signals 升级 tier。

```markdown
# Lena Kovac

> Technical builder. Engaged with a post about developer tooling on X.

## State
- **X:** @lena_builds
- **Relationship:** None yet — social interaction only
- **Confidence:** low (1 interaction)

---

## Timeline
- **2026-04-07** | X reply — Replied to post about developer tools.
  Thoughtful technical take on compiler-driven UX. 50+ likes.
```

核心洞见：**plumbing 正确时，knowledge 会自主复利。**

## Ingest Workflows

### Meeting ingestion

每次 meeting 后（Circleback、Otter、Fireflies 或 manual notes）：

1. 拉 meeting notes + full transcript
2. 创建 brain meeting page，写**你自己的分析**
3. **Propagate to entity pages**：对每个讨论到的人和公司 call enrich
4. 抽取 action items 到 task list
5. Commit

### Email ingestion

处理 email 时：
- 抽取提到的人和公司
- 带 email context 调用 enrich
- 记录 scheduling、commitments、follow-ups

### Social media ingestion

监控 social media 时：
- 捕捉你关注的人公开说的话
- 检测 engagement patterns
- 对 notable accounts 调用 enrich

### Manual ingestion

你在 conversation 中提到某人或某事时：
- 你自己的评论是最高价值 signal，始终捕捉
- 如果 brain page 很薄，触发 full enrichment

## Navigation and Concurrency

**index.md** 是 content catalog。**log.md** 是 ingests/updates 的 chronological record，append-only。500+ pages 时添加 search tooling；中等规模 grep 足够。

### Write hotspots and concurrency

cron jobs、ingest jobs 和 sub-agents 同时改 brain repo 时，**index.md 和 log.md 会成为 merge-conflict magnets。** 缓解：
- **Treat index.md as derived, not hand-maintained.**
- **Make log.md append-safe.**
- **Commit in batches, not per-page.**
- **Pull before push.**
- **Entity pages rarely conflict.**

## Maintenance（Lint）

agent 应定期（每周）执行：
- **Deduplication scan**
- **Contradictions**
- **Staleness**
- **Orphans**
- **Open Threads**
- **Missing cross-references**
- **Missing pages**
- **MECE filing**
- **Source audit**
- **Alias coverage**

## What makes this different from RAG

RAG 每次 query 都重新推导知识。brain 预计算 synthesis 并保持最新：

- **Cross-references are pre-built.**
- **Contradictions are pre-flagged.**
- **The compilation is persistent.**
- **The structure itself is a prompt.**

## Page Lifecycle

Brain pages 可有隐式 lifecycle states：

- **Active:** 当前、最近更新、ongoing relationship 或 relevance
- **Dormant:** 6+ months 未更新、关系降温但仍可能 relevant
- **Archived:** 移到 `archive/`，仅历史记录
- **Graduated:** idea 变 project，或 project 变 program；旧页链接到新页

lint passes 中标记 6+ months 未更新 pages 供 review。

## What makes a great brain

一个优秀 brain 让你进入任何 meeting、call 或 decision 前已经知道：
1. 这个人是谁、关心什么
2. 公司的真实当前状态
3. 你们之间有哪些 open threads
4. 最近变化了什么
5. 需要留意什么

坏 brain 是没人读的 LinkedIn scrapes 和 meeting transcripts 堆。好 brain 是 compiled context，让你在每次互动中更有效。

## The Resolver

创建或归档新页面时，走这棵 decision tree。每条知识有且只有一个 home。

### Decision Tree

**Start here: what is the primary subject?**

1. **A specific named person** → `people/`
2. **A specific organization** → `companies/`
3. **A financial transaction** → `deals/`
4. **A record of a specific meeting/call** → `meetings/`
5. **Something being actively built** → `projects/`
6. **A raw possibility** → `ideas/`
7. **A reusable mental model or thesis** → `concepts/`
8. **A piece of prose** → `writing/`
9. **Your institution's strategy, org, processes, internal dynamics** → `org/`
10. **Political or civic landscape** → `civic/`
11. **Public narrative or content operations** → `media/`
12. **A major life program** → `programs/`
13. **Domestic operations** → `household/`
14. **Private notes** → `personal/`
15. **A hiring pipeline** → `hiring/`
16. **A reusable LLM prompt** → `prompts/`
17. **A raw data import or snapshot** → `sources/`
18. **Agent deliverables** → `agent/`
19. **Unsorted / quick capture** → `inbox/`
20. **Dead / no longer relevant** → `archive/`

### Disambiguation Rules

- **Person vs. Company:** 关于人本身是 people/；关于其组织是 companies/。
- **Concept vs. Idea:** 能教别人是 Concept；能 build 是 Idea。
- **Concept vs. Personal:** 可公开专业分享是 Concept；私人反思是 Personal。
- **Idea vs. Project:** 有人在做就是 Project；否则 Idea。
- **Writing vs. Concepts:** Concepts distilled；Writing developed prose。
- **Writing vs. Media:** Writing 是 artifact；Media 是 infrastructure。
- **Org vs. Programs:** org/ 是关于组织的 institutional knowledge；programs/ 是你个人在其中的角色和优先级。
- **Civic vs. People:** 政治人物本身放 people/；其 legislative agenda 和 political positioning 放 civic/。
- **Household vs. Personal:** PA 会执行的是 household；private reflection 是 personal。
- **Sources vs. .raw/ sidecars:** per-entity enrichment data → `.raw/`；bulk imports → `sources/`。
- **Agent vs. Sources:** Sources feed into brain；Agent deliverables feed into your reading。

### Special directories（not knowledge）

- **templates/** — page templates
- **attachments/** — binary attachments（images、PDFs），由 editor 管理，不由 agent 管理

### MECE Check

每条知识都应通过 decision tree 并落在唯一目录。如果确实不适合任何分类，放入 inbox/ 并标记，这说明 schema 需要演进。

## Getting started

1. 创建上述目录结构（或让 agent 创建）
2. 写 `RESOLVER.md` decision tree 和每个目录的 `README.md` resolver
3. 写 `schema.md`，包含 page conventions 和 templates
4. 把 brain rules 作为 hard rules 加入 agent config（AGENTS.md 或等价文件）
5. 从一个 meeting transcript 或一个想追踪的人开始
6. 让 agent 构建前几个 pages，你 review 并迭代 schema
7. 接入 meeting tool 触发 ingestion
8. 接入 enrichment，让每个 new person/company signal 都触发
9. brain 从此开始复利

人类的工作：策展 sources、指导分析、提出好问题，并思考一切的意义。agent 的工作：其他所有事情。
