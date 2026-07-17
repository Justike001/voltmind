---
type: essay
title: "Thin Harness, Fat Skills"
subtitle: "How to Make AI Agents Actually Understand Your Data"
author: Garry Tan
created: 2026-04-09
updated: 2026-04-11
tags: [ai, agents, gstack, harness-engineering, skills, architecture]
status: draft-v4
talk: "YC Spring 2026 -- Thin Harness, Fat Skills"
thread: https://x.com/garrytan/status/2042925773300908103
---

# Thin Harness, Fat Skills

Steve Yegge 说，使用 AI coding agents 的人“比今天使用 Cursor 和 chat 的工程师高效 10x 到 100x，大约比 2005 年的 Googlers 高效 1000x。”

这是一个真实数字。我见过，也亲身经历过。但当人们听到 100x 时，他们想到的是：更好的模型。更聪明的 Claude。更多参数。

这个框架完全错了。2x 的人和 100x 的人用的是同样的模型。差异来自五个可以写在索引卡片上的概念。

## The harness is the secret sauce

2026 年 3 月 31 日，Anthropic 意外把 Claude Code 的完整源代码发布到了 npm registry。512,000 行。我读完后，它确认了我一直在 YC 教的东西。秘密不在模型。秘密在包裹模型的东西：harness。实时 repo context。Prompt caching。为任务定制的 tools。最小化 context bloat。结构化 session memory。并行 sub-agents。

这些都不是让模型更聪明。它们都是在正确时间给模型正确 context，同时不让它淹没在噪声里。

这才是唯一重要的问题。答案有一个具体形状。我称之为 **thin harness, fat skills**。

## Five definitions

瓶颈从来不是模型的智能。瓶颈是模型是否理解你的 schema。模型已经会推理、综合、写代码。它们失败，是因为它们不了解你的数据。五个定义可以修复这一点。

### Definition 1: Skill File

skill file 是一个可复用的 markdown procedure，教模型 HOW to do something。不是 WHAT to do。用户提供具体内容。skill 提供过程。

**Markdown is actually code.** skill file 是比刚性源代码更完美的 capability 封装，因为它用模型已经在其中思考的语言描述 process、judgment 和 context。

左边是一个叫 `/investigate` 的 skill。七个步骤：scope dataset、build timeline、diarize every document、synthesize、argue both sides、cite sources。它接收三个参数：TARGET、QUESTION 和 DATASET。

右边是同一个 skill 的两个完全不同调用。一个指向 Dr. Sarah Chen 和 210 万封 discovery emails，询问一位 safety scientist 是否被噤声。另一个指向 Pacific Corporate Services 和 FEC filings，询问 shell companies 是否在协调 campaign donations。

同一个 skill。同样七步。同一个 markdown file。一个场景中它是医学研究分析师。另一个场景中它是 forensic investigator。skill 描述的是判断过程。调用提供世界。

**这是多数人错过的关键洞见：skill file 像 method call 一样工作。** 它接收参数。你用不同 arguments 调用它。相同 procedure 会根据传入内容产生截然不同的能力。这不是 prompt engineering。这是 software design，把 markdown 当作 programming language，把 human judgment 当作 runtime。

### Definition 2: Harness

harness 是运行 LLM 的程序。它做四件事：循环运行模型、读写你的文件、管理 context、强制执行 safety。这就是 “thin”。

反模式是 fat harness with thin skills：40+ tool definitions 吃掉半个 context window。God tools 带来 2 到 5 秒 MCP round-trips。REST API wrappers 把每个 endpoint 都变成 tool。3x tokens，3x latency，3x failure rate。

你应该构建的是：一个 Playwright CLI，让每个浏览器操作在 100 毫秒内完成。对比：Chrome MCP 做 screenshot + find + click + wait + read 要 15 秒。Playwright CLI 做 screenshot + assert 要 200 毫秒。快 75x。Software 不必再那么珍贵。构建你真正需要的东西。

### Definition 3: Resolver

resolver 是 context 的 routing table。当 task type X 出现时，先加载 document Y。

Skills 说 HOW。Resolvers 说 WHAT to load WHEN。开发者改了一个 prompt。没有 resolver，他们直接 ship。有了 resolver，模型会先读 `docs/EVALS.md`，里面写着：运行 eval suite、比较 scores、如果 accuracy 下降超过 2%，revert 并调查。开发者不知道 eval suite 存在。resolver 在正确时刻加载了正确 context。

Claude Code 有内置 resolver。每个 skill 都有 description field，模型会自动把用户 intent 匹配到 skill descriptions。你永远不必记得 `/ship` 存在。description IS the resolver。像 Clippy。只是它真的有用。

一个 confession：我的 CLAUDE.md 曾经有 20,000 行。我遇到的每件事都放进去。每个怪癖、每个 pattern、每个 lesson。完全荒唐。模型注意力退化。Claude Code 甚至告诉我把它砍短。修复方式：约 200 行。只保留指向文档的指针。resolver 在重要时刻加载正确文档。

### Definition 4: Latent vs. Deterministic

系统中的每一步要么是 latent，要么是 deterministic。

**Latent space** 是 intelligence 存在的地方。模型阅读、解释、决定。Judgment。Synthesis。Pattern recognition。

**Deterministic** 是 trust 存在的地方。相同输入，相同输出。每一次。SQL。Code。Numbers。

LLM 可以安排 8 个人的晚餐座位。让它安排 800 人，它会 hallucinate 一个看起来 plausible 但完全错误的 seating chart。这是把 deterministic problem 强行塞进 latent space。最糟糕的系统把工作放在了错误的一侧。

### Definition 5: Diarization

模型阅读关于某个 subject 的全部内容，并写出结构化 profile。读 50 篇文档，产出 1 页判断。

没有 SQL query 会产生这个。没有 RAG pipeline 会产生这个。模型必须真正阅读、在脑中保持矛盾、注意什么在何时改变，并写出结构化 intelligence。这就是 AI 对真实知识工作有用的原因。

## The architecture

三层：

**Fat skills** 在上层。编码 judgment、process 和 domain knowledge 的 markdown procedures。90% 的价值在这里。

**Thin CLI harness** 在中层。约 200 行。JSON in，text out。默认 read-only。CLI first，之后再加 MCP。

**Your app** 在底层。QueryDB。ReadDoc。Search。Timeline。确定性基础。

把 intelligence 推 UP 到 skills。把 execution 推 DOWN 到 deterministic tooling。保持 harness THIN。

## The system that learns: YC Startup School

让我展示这五个定义如何协同工作。不是理论。在 YC 正在构建的真实系统中。

Chase Center。2026 年 7 月。6,000 位 founders。每个人都有结构化 application、questionnaire answers、来自 1:1 advisor chats 的 transcripts，以及 public signals：X posts、GitHub commits、Claude Code transcripts 显示他们 shipping 的速度。

传统方法：15 人 program team 阅读 applications、凭直觉判断、更新 spreadsheet。200 位 founders 时可行。6,000 位时崩溃。

没有人能在 working memory 中容纳 6,000 个 profiles，并注意到 infrastructure-for-AI-agents cohort 的三个最佳候选人分别是 Lagos 的 dev tools founder、Singapore 的 compliance founder，以及 Brooklyn 的 CLI-tooling founder，他们都在 1:1 chats 中用不同话语描述了同一个 pain point。

模型可以。

**Step 1: Enrich every founder.**

`/enrich-founder` skill：拉取所有 sources，运行 enrichments，diarize，突出他们 SAY vs ACTUALLY BUILDING。右侧是 deterministic calls：SQL 找 stale profiles、GitHub stats、demo URL 的 browser test、social signal pulls、CrustData company intel。

Cron 每晚 2am 运行。6,000 profiles，每晚，始终新鲜。

diarization output 会捕获 keyword search 找不到的东西：

```
FOUNDER: Maria Santos
COMPANY: Contrail (contrail.dev)
SAYS: "Datadog for AI agents"
ACTUALLY BUILDING: 80% of commits are in billing module.
  She's building a FinOps tool disguised as observability.
```

“SAYS” vs “ACTUALLY BUILDING”。这需要阅读 GitHub commit history、application 和 advisor transcript，并同时把三者放在脑中。

**Step 2: Match 6,000 founders. Make judgment calls.**

这就是 skill-as-method-call 真正发光的地方。三个调用：

`/match-breakout`: 1,200 founders，按 sector affinity 聚类，每房间 30 人。Embed + deterministic assign。

`/match-lunch`: 600 founders，serendipity matching（cross-sector），每桌 8 人，不重复。LLM 发明 themes，然后 assign。

`/match-live`: 当前在 zone 的人，nearest-neighbor embedding，200ms 实时，1:1 pairs，且此前未见过。

同一个 skill。三个调用。三种完全不同的 matching strategies。不同参数、不同策略、不同 group sizes。skill 描述 process。arguments 塑造 output。

以及模型的 judgment calls：“Santos 和 Oram 都是 AI infra，但不是 competitors。Santos 是 cost attribution，Oram 是 orchestration。把他们放进同一组。” 还有：“Kim 申请时写的是 ‘developer tools’，但他的 1:1 transcript 显示他在做 SOC2 compliance automation。把他移到 FinTech/RegTech。”

没有 embedding 能捕获 Kim 的 reclassification。没有算法能做到。模型必须阅读整个 profile。

**Step 3: The self-learning loop.**

活动结束后，`/improve` skill 读取 NPS surveys，diarize “OK” responses（不是差评，而是平庸评价），并提取 patterns。然后它提出新规则并把它们写回 matching skills：

```
When attendee says "AI infrastructure"
    but startup is 80%+ billing code:
    -> Classify as FinTech, not AI Infra.

When two attendees in same group
    already know each other:
    -> Penalize proximity.
       Prioritize novel introductions.
```

这些 rules 被写回 skill file。下一次运行会自动使用它们。skill 会重写自己。

七月活动：“OK” ratings 12%。下一次活动：4%。skill file 学会了 “OK” 真正意味着什么。

同样 pattern 适用于每个 domain：retrieve、read、diarize、count、synthesize。然后：survey、investigate、diarize、rewrite the skill。它到处迁移。

## OpenClaw: where the skills live

我还想讲另一个 harness。不是用于 coding。用于其他一切。

我在 OpenClaw 上运行个人 AI agent。它有人格，知道我是谁，并维护一个由数千个相互连接文件组成的 knowledge base。但真正让它有效的，是完全相同的原则。Thin harness, fat skills。

几天前我发过一条推：

> *You are not allowed to do one-off work. If I ask you to do something and it's the kind of thing that will need to happen again, you must: do it manually the first time on 3 to 10 items. Show me the output. If I approve, codify it into a skill file. If it should run automatically, put it on a cron.*

> *The test: if I have to ask you for something twice, you failed.*

这引起了共鸣：一千个 likes，二千五百个 bookmarks。人们以为这是 prompt engineering trick。不是。这是同一个架构。

Claude Code 是最好的 coding harness。OpenClaw 是其他一切的最佳 harness：email、calendar、meetings、people、research、alerts。原则相同。Thin harness。Fat skills。skills 是 method calls。参数会变。过程保持。

我写的每个 skill 都是一次永久升级。它不会退化。不会遗忘。会在凌晨 3 点我睡觉时运行。下一个模型发布时，每个 skill 都会立刻变好，因为 latent steps 中的 judgment 提升了，而 deterministic steps 保持完全可靠。

这就是你得到 Yegge 所说 10x 到 100x 的方式。不是更聪明的模型。是 fat skills、thin harness，以及把一切 codify 的纪律。

系统会复利。构建一次。永远运行。

五个定义。三层。一个原则。Thin harness, fat skills。

---

## Agent Decision Guide: Skill or Code?

构建 VoltMind features 时，使用这份决策指南：

| Question | If YES | If NO |
|----------|--------|-------|
| Does the agent need to think, adapt, or ask questions? | **Skill** (recipe markdown) | Code |
| Same input always produces same output? | **Code** (CLI command) | Skill |
| Does it require judgment about the user's environment? | **Skill** | Code |
| Is it a lookup, list, or status check? | **Code** | Probably skill |
| Does it change behavior based on conversation context? | **Skill** | Code |

**VoltMind examples:**
- `voltmind integrations list` = **Code**（读取文件、检查 env vars、deterministic）
- `voltmind integrations status` = **Code**（检查 env vars + heartbeat、deterministic）
- `voltmind integrations doctor` = **Code**（运行 health checks、deterministic）
- `voltmind integrations stats` = **Code**（聚合 JSONL、deterministic）
- Recipe setup flow = **Skill**（询问 API keys、适配环境、验证）
- Recipe changelog surfacing = **Skill**（agent 以对话方式描述 changes）
- Entity detection = **Skill**（读取 message、判断重要内容、创建 pages）
- Meeting ingestion = **Skill**（读取 transcript、提取 entities、更新 pages）

**The rule:** 如果它是 lookup table，就是 code。如果 agent 需要思考，就是 skill。
