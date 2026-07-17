---
type: essay
title: "Homebrew for Personal AI"
subtitle: "Why Markdown is Code and Your Agent is a Package Manager"
author: Garry Tan
created: 2026-04-11
updated: 2026-04-11
tags: [ai, voltmind, gstack, markdown-is-code, open-source, software-distribution, agents, openclaw]
status: draft-v2
prior: "Thin Harness, Fat Skills"
---

# Homebrew for Personal AI

`brew install` 给你的是别人的 binary。`npm install` 给你的是别人的 source code。两者都要求你理解工具、配置它、集成它、维护它。

如果软件分发以另一种方式工作呢？如果你可以用普通英文描述一种能力，把这份描述交给 AI agent，然后 agent 构建一个适配你设置的原生实现呢？

这就是 markdown is code 时发生的事情。

## Markdown is code

这里有一个真实的 skill file。它教 AI agent 筛选电话：

```markdown
# Voice Agent — Your Phone Number

Caller → Twilio → <Stream> WebSocket → Voice Server (port 8765)
                                            ↕ audio
                                      OpenAI Realtime API
                                            ↓ tool calls
                                      Brain / Calendar / Telegram

## Call Routing

Every inbound call routes based on caller phone number + brain lookup:

### Owner → Authenticated Mode
- Send crypto-random 6-digit code to secure channel
- Caller reads it back
- Match → full assistant mode (brain, calendar, scheduling)
- No match → treated as unknown caller

### Known Person, Inner Circle (brain score ≥ 4) → Forward
- Greet by name with brain context
- Transfer to cell
- If no answer (30s timeout), take message
- Text Telegram with who called and context

### Unknown Caller → Screen
- Get their name, look them up in brain
- If inner circle → offer to transfer
- Otherwise → take message
- Create brain entry with phone number (marked UNVERIFIED)
```

这不是伪代码。不是文档。这是一个 working specification，像 Claude Opus 4.6 这种拥有百万 token context window 的模型可以读取并实现它。架构图告诉它组件。routing table 告诉它逻辑。security model 告诉它约束。agent 读取这个文件，理解它，并构建 Twilio integration、WebSocket server、Telegram bot hooks、brain lookup，全部内容都按用户已有 infrastructure 塑形。

skill file 是一个 method call。它接收参数（你的电话号码、你的 brain、你偏好的 messaging app）。同一个 skill，不同 arguments，不同 implementation。procedure 是 package。model 是 runtime。

## The distribution mechanism

传统 package managers 分发 artifacts：compiled binaries、source tarballs、container images。consumer 运行别人的代码。

VoltMind 分发 recipes：markdown files，以足够具体的方式描述 capabilities，使 AI agent 可以从零实现它们。consumer 得到的是原生实现。没有 dependency hell。没有 version conflicts。没有 transitive vulnerability chains。因为没有 upstream code。只有一份说明要构建什么、为什么构建的描述。

工作方式如下：

1. **Build a feature.** 实现 voice agent、meeting ingestion pipeline、email triage system、investment diligence workflow，随便什么。

2. **VoltMind captures the recipe.** 不只是代码。还包括 architecture、integration points、failure modes、judgment calls。一份编码完整 capability 的 markdown file。

3. **Push to the repo.** Open source。任何人都能读。

4. **Someone else's agent pulls the recipe.** 读取 markdown。说：“New recipe available: AI voice agent with caller screening. Want it?” 用户说 yes。agent 读取 spec 并构建它。

没有安装。没有 configuration wizard。没有 README。agent 读了一份文档，然后弄明白了。

## Why this works now

两年前这行不通。有两件事变了。

**Context windows hit a million tokens.** 一个真实的 meeting ingestion skill file 有 200+ 行。调用它的 enrichment skill 引用了 brain schema、resolver、citation standard、五个 external APIs 和 cross-linking protocol。实现这个 recipe 的 agent 需要同时把所有内容放在 working memory 中，还要理解用户已有 setup。8K tokens 时不可能。128K 勉强。1M 舒适。

**Models crossed the judgment threshold.** 下面是真实 enrichment recipe 的片段：

```markdown
## Philosophy

A brain page should read like an intelligence dossier crossed
with a therapist's notes, not a LinkedIn scrape. We want:

- What they believe — ideology, worldview, first principles
- What they're building — current projects, what's next
- What motivates them — ambition drivers, career arc
- What makes them emotional — angry, excited, defensive, proud
- Their trajectory — ascending, plateauing, pivoting, declining?
- Hard facts — role, company, funding, location, contact info

Facts are table stakes. Texture is the value.
```

实现这个 recipe 的模型必须理解 LinkedIn scrape 和 intelligence dossier 之间的差异。这是关于哪些信息值得捕获、如何赋权重的 judgment call。GPT-3 做不到。GPT-4 勉强能做。Opus 4.6 做得很好。关键技术是足够聪明、能够解释意图的模型，而不只是执行指令。

## What a recipe actually contains

好的 recipe 有五个 sections：

**Architecture.** 组件图。什么与什么通信、通过什么协议、以什么数据流通信。这是 agent 首先构建的骨架。

**Routing logic.** 决策树。当 X 发生，做 Y。当 Z 失败，fallback 到 W。domain knowledge 在这里。voice agent recipe 编码 call routing。diligence recipe 编码如何处理 pitch decks vs. financial models vs. cap tables。meeting ingestion recipe 编码如何把 raw transcript 转成 actionable intelligence。

**Integration points.** 这会触及哪些 external systems？Twilio、Telegram、Gmail、Circleback、Slack、GitHub、Supabase 等等。recipe 命名 integrations；agent 根据用户已有配置弄清如何连接。

**Judgment calls.** 最难的部分。不是 “send an email”，而是 “根据 sender importance、time sensitivity，以及是否需要 decision，判断这封 email 是否值得浮出给用户。” 跳过 judgment calls 的 recipes 会产生浅实现。judgment calls 才是真正价值。

**Failure modes.** 什么会出错，以及如何处理。“If Circleback token expires, message the user and ask them to reconnect. Don't silently skip.” “If caller ID is spoofed, never trust it for authentication. Use a challenge-response code via a separate channel.” 没有 failure modes 的 recipes 会产生脆弱系统。

这里有一个真实例子。这是 diligence recipe 的 detection logic：

```markdown
## Detection

Recognize data room materials by:
- PDF filenames: "Data Deck", "Intro Deck", "Cap Table",
  "Financial Model", "Pitch Deck", "Series [A-D]"
- Spreadsheets with tabs: Revenue, Retention, Cohorts,
  CAC, Gross Margin, Unit Economics, ARR
- User saying: "data room", "diligence", "deck", "pitch"
- Context: shared in the Diligence topic
```

这是用英文表达的 pattern matcher。agent 读到它，就知道如何分类 incoming documents。没有 regex。没有 file type configuration。只有 pattern 描述，以及模型对给定 document 是否匹配的判断。

## Pick and choose

VoltMind 不是 monolithic。Recipes 是独立的。挑你想要的：

- **Voice agent** — phone screening、caller ID、brain lookup、message routing
- **Meeting ingestion** — transcript processing、entity extraction、action item capture、timeline updates
- **Email triage** — inbox sweep、priority classification、draft replies、scheduling extraction
- **Enrichment pipeline** — 从多个 data sources 对 people 和 company 做 research，并 diarize 到 brain pages
- **Diligence processing** — data room ingestion、PDF extraction、financial model analysis
- **Social monitoring** — X/Twitter timeline analysis、mention tracking、narrative detection
- **Content pipeline** — idea capture、link ingestion、article summarization

每个 recipe 都是 self-contained。你的 agent 知道你已有的东西。VoltMind 每天 ping：“Three new recipes since last sync. Want any?” 你选择。它构建。

而且因为 source code 是英文，forking 很简单。不喜欢 voice agent 处理 unknown callers 的方式？编辑 markdown。把 “take a message” 改成 “ask three screening questions first.” 行为会改变，因为 spec 改了。

## The thin harness, fat skills connection

这篇 essay 是续集。前传是 “Thin Harness, Fat Skills”，它认为 100x AI productivity 的秘密不是更好的模型，而是更好的 context management。保持 harness thin（运行模型的程序）。让 skills fat（编码 judgment 和 process 的 markdown procedures）。

“Markdown is code” 是分发推论。如果 skills 是 fat markdown files，并且模型足够聪明，可以从 markdown 实现，那么 skills 就是可分发的软件。skill file 同时是：

- **Documentation**，供人类阅读
- **Specification**，供 implementing agent 使用
- **Package**，供 distribution system 使用
- **Source code**，供最终 capability 使用

四种 artifacts 合并成一种。这就是它不同于以往每种 package manager 的地方。`brew install` 将 formula、binary、docs、source 分开。VoltMind 把它们合并。markdown 就是全部四者。

## The architecture underneath

三层，和那场 talk 一样：

**Fat skills** 在顶部。Markdown recipes 编码 judgment、process、failure modes 和 domain knowledge。90% 的价值在这里。这是被分发的东西。

**Thin harness** 在中间。运行模型的程序。File operations、tool dispatch、context management、safety enforcement。约 200 行。OpenClaw 或任何等价物。harness 约束越少，recipes 就越能表达。

**Deterministic foundation** 在底部。Databases、APIs、CLIs。相同输入，相同输出，每一次。SQL queries、HTTP calls、file reads。skills 描述 WHEN to call these；harness 执行它们。

把 intelligence 推 UP 到 skills。把 execution 推 DOWN 到 deterministic tooling。分发 skills。这就是整个系统。

## What this means

当 implementation cost 接近零时，瓶颈会转移。不再是 “can we build this?” 而是 “should we build this?” 和 “what exactly should it do?”

Taste、vision 和 domain knowledge 成为稀缺资源。深刻理解 call screening 并写出精确 recipe 的人，比能从零实现 Twilio integration 的人创造更多价值。recipe IS the implementation。

这也意味着最好的 AI agent setups 默认会是 open source。闭源 proprietary agent configurations 要与这样一个世界竞争：有人发布一个 recipe，一千个 agents 一夜之间实现它。recipe 以 git push 的速度传播。moat 是 taste，不是 code。

重新想象软件分发：package 是 markdown file，runtime 是足够聪明的 model，package manager 是你的 AI agent，app store 是 git repo。

`voltmind install voice-agent`

就是这样。
