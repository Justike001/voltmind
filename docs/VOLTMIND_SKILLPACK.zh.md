<!-- skillpack-version: 0.7.0 -->
<!-- source: https://raw.githubusercontent.com/garrytan/voltmind/master/docs/VOLTMIND_SKILLPACK.md -->
# VoltMind Skillpack：AI Agents 的参考架构

这是生产级 AI agent 如何把 voltmind 用作知识骨干的参考架构。它基于真实部署中的模式：14,700+ brain files、40+ skills，以及 20+ 持续运行的 cron jobs。

**memex 愿景已经实现。** Vannevar Bush 曾设想一种设备，让个人存储一切，并以机械化方式高速查询。VoltMind 就是这种设备，只是 memex 会自己构建自己。Agent 会检测实体、丰富页面、创建交叉引用，并自动维护 compiled truth。

下面每个 section 都是独立指南。点击可进入完整内容。

---

## Core Patterns

基础的读写循环和数据模型。

| Guide | What It Covers |
|-------|---------------|
| [The Brain-Agent Loop](guides/brain-agent-loop.md) | 让 brain 随时间复利增长的 read-write cycle |
| [Entity Detection](guides/entity-detection.md) | 对每条消息运行。捕捉原始想法 + 实体提及 |
| [The Originals Folder](guides/originals-folder.md) | 捕捉“你怎么想”，不只是“你发现了什么” |
| [Brain-First Lookup](guides/brain-first-lookup.md) | 调任何外部 API 前先查 brain |
| [Compiled Truth + Timeline](guides/compiled-truth.md) | 线上方：当前 synthesis。下方：append-only evidence |
| [Source Attribution](guides/source-attribution.md) | 每个事实都需要引用。格式与层级 |

## Data Pipelines

获取数据并保持更新。

| Guide | What It Covers |
|-------|---------------|
| [Enrichment Pipeline](guides/enrichment-pipeline.md) | 7-step protocol，按重要性分 Tier 1/2/3 |
| [Meeting Ingestion](guides/meeting-ingestion.md) | 总是拉完整 transcript，并传播到所有 entity pages |
| [Content & Media Ingestion](guides/content-media.md) | YouTube、社交媒体 bundles、PDF/documents |
| [Diligence Ingestion](guides/diligence-ingestion.md) | Data room materials：pitch decks、financial models、cap tables |
| [Deterministic Collectors](guides/deterministic-collectors.md) | Code 负责数据，LLM 负责判断。collector pattern |
| [Idea Capture & Originals](guides/idea-capture.md) | 深度测试、原创性分布、深度交叉链接 |
| [Getting Data In](integrations/README.md) | Integration recipes：voice、email、X、calendar |

## Operations

运行生产级 brain。

| Guide | What It Covers |
|-------|---------------|
| [Reference Cron Schedule](guides/cron-schedule.md) | 20+ recurring jobs、quiet hours、dream cycle |
| [Cron via Minions](../skills/conventions/cron-via-minions.md) | 为什么 scheduled work 以 Minion jobs 运行，而不是 `agentTurn`。v0.11.0 migration 会对 built-in handlers 自动应用；host-specific handlers 使用下方 plugin contract。 |
| [Plugin Handlers](guides/plugin-handlers.md) | 通过代码注册 host-specific Minion handlers（无 data-file exec surface）。 |
| [Minions fix](guides/minions-fix.md) | 修复半迁移的 v0.11.0 install。 |
| [Shell jobs (v0.14.0+)](guides/minions-shell-jobs.md) | 把 deterministic crons（API fetch、token refresh、scrape+write）移出 LLM gateway。每次触发零 tokens，约 60% gateway headroom。按 `skills/migrations/v0.14.0.md` 执行 adoption playbook。 |
| [Quiet Hours & Timezone](guides/quiet-hours.md) | 睡眠期间暂停通知，timezone-aware delivery |
| [Executive Assistant Pattern](guides/executive-assistant.md) | Email triage、meeting prep、scheduling |
| [Operational Disciplines](guides/operational-disciplines.md) | Signal detection、brain-first、sync-after-write、heartbeat、dream cycle |
| [Skill Development Cycle](guides/skill-development.md) | 5-step cycle：concept、prototype、evaluate、codify、cron |

**Subagent routing（v0.11.0+）：** 分发后台工作的 agents 应通过 `skills/conventions/subagent-routing.md`；它读取 `~/.voltmind/preferences.json#minion_mode`，并在 native subagents 与 Minion jobs 之间分支。v0.11.0 migration 会自动在 AGENTS.md 中注入指向该 convention 的 marker。

**Cron routing（v0.11.0+）：** scheduled work 通过 Minions，而不是 OpenClaw 的 `agentTurn`。见 `skills/conventions/cron-via-minions.md` 的 rewrite pattern。v0.11.0 migration 会自动重写 handler 是 voltmind builtin 的 entries；host-specific handlers（例如 `ea-inbox-sweep`）需要按 `docs/guides/plugin-handlers.md` 做 code-level registration。

## Architecture

如何构造你的系统。

| Guide | What It Covers |
|-------|---------------|
| [Two-Repo Architecture](guides/repo-architecture.md) | Agent repo vs brain repo、boundary rules、decision tree |
| [Sub-Agent Model Routing](guides/sub-agent-routing.md) | 哪个任务用哪个 model、signal detector pattern、cost optimization |
| [The Three Search Modes](guides/search-modes.md) | Keyword、hybrid、direct。何时使用 |
| [Brain vs Agent Memory](guides/brain-vs-memory.md) | 3 层：VoltMind（world knowledge）、agent memory、session |

## Integrations

把你的生活接进来。

| Guide | What It Covers |
|-------|---------------|
| [Credential Gateway](integrations/credential-gateway.md) | ClawVisor / Hermes for Gmail、Calendar、Contacts |
| [Meeting & Call Webhooks](integrations/meeting-webhooks.md) | Circleback transcripts + Quo/OpenPhone SMS/calls |
| [Voice-to-Brain](../recipes/twilio-voice-brain.md) | Phone calls + WebRTC browser calls 创建 brain pages。25 个生产模式：identity separation、bid system、conversation timing、proactive advisor、prompt compression、caller routing、dynamic VAD、real-time logging、belt-and-suspenders post-call |
| [Email-to-Brain](../recipes/email-to-brain.md) | Gmail messages 通过 deterministic collector 流入 entity pages |
| [X-to-Brain](../recipes/x-to-brain.md) | Twitter monitoring，带 deletion detection + engagement velocity |
| [Calendar-to-Brain](../recipes/calendar-to-brain.md) | Google Calendar events 变为可搜索的 daily brain pages |
| [Meeting Sync](../recipes/meeting-sync.md) | Circleback transcripts 自动导入并传播 attendees |

## Administration

保持系统运行并持续更新。

| Guide | What It Covers |
|-------|---------------|
| [Upgrades & Auto-Update](guides/upgrades-auto-update.md) | check-update、agent notifications、migration files |
| [Live Sync](guides/live-sync.md) | 保持 index 最新：cron、--watch、webhook approaches |

## Getting Started

setup 后，brain 是空的。cold-start skill 会按最高杠杆的数据源顺序填充它：

| Guide | What It Covers |
|-------|---------------|
| [Cold Start](../skills/cold-start/SKILL.md) | 第一天 bootstrap：contacts、calendar、email、conversations、social、archives。使用 ClawVisor 做安全 credential handling，agents 永远不持有原始 API keys。 |
| [Ask User](../skills/ask-user/SKILL.md) | 决策点的人类输入 choice-gate pattern。cold-start 和其他 skills 使用。 |

---

## Appendix: VoltMind CLI Quick Reference

| Command | Purpose |
|---------|---------|
| `voltmind search "term"` | 在所有 brain pages 上做 keyword search |
| `voltmind query "question"` | Hybrid search（vector + keyword + RRF） |
| `voltmind get <slug>` | 按 slug 读取指定 brain page |
| `voltmind sync` | 同步本地 markdown repo 到 voltmind index |
| `voltmind import <path>` | 把 files 导入 brain |
| `voltmind embed --stale` | 重新 embedding 过期或缺失 embedding 的 pages |
| `voltmind integrations` | 管理 integration recipes（senses + reflexes） |
| `voltmind stats` | 显示 brain statistics（page count、last sync 等） |
| `voltmind doctor` | 诊断 brain health issues |
| `voltmind check-update` | 检查新版本和 integration recipes |

运行 `voltmind --help` 获取完整命令参考。

---

## Architecture & Philosophy

- [Infrastructure Layer](architecture/infra-layer.md) — Import pipeline、chunking、embedding、search
- [Thin Harness, Fat Skills](ethos/THIN_HARNESS_FAT_SKILLS.md) — 架构哲学
- [Markdown Skills as Recipes](ethos/MARKDOWN_SKILLS_AS_RECIPES.md) — 为什么 markdown 是 code，而你的 agent 是 package manager
- [Homebrew for Personal AI](designs/HOMEBREW_FOR_PERSONAL_AI.md) — 10-star vision
- [Recommended Schema](VOLTMIND_RECOMMENDED_SCHEMA.md) — brain repo 的目录结构
- [Verification Runbook](VOLTMIND_VERIFY.md) — 端到端安装验证
