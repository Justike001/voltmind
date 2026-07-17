# 面向个人 AI 基础设施的 Homebrew

VoltMind integration system 的 10-star 愿景。先 ship Approach B（v0.7.0），再在后续 release 中朝这里推进。

## 愿景

VoltMind 成为一个个人基础设施操作系统，让你生活中的每个信号都自动流经 brain。Integrations 是 **senses**（数据输入）和 **reflexes**（对模式的自动响应）。用户订阅 creator 实际在用的操作系统，然后在其上定制。

```
$ voltmind integrations

  SENSES (data inputs)                          STATUS
  -------------------------------------------------------
  voice-to-brain    Phone calls -> brain pages  ACTIVE    last call: 2h ago
  email-to-brain    Gmail -> entity updates     ACTIVE    47 emails today
  x-to-brain        Twitter -> media pages      ACTIVE    312 tweets tracked
  calendar-to-brain Google Cal -> meeting prep  ACTIVE    3 meetings tomorrow
  photos-to-brain   Camera roll -> visual mem   AVAILABLE
  slack-to-brain    Slack -> conversation index  AVAILABLE
  rss-to-brain      RSS feeds -> media pages     AVAILABLE

  REFLEXES (automated responses)                STATUS
  -------------------------------------------------------
  meeting-prep      Brief me before meetings    ACTIVE    next: 9am tomorrow
  entity-enrich     Auto-enrich new contacts    ACTIVE    12 enriched today
  dream-cycle       Overnight brain maintenance ACTIVE    last run: 3am
  deal-tracker      Alert on deal changes       AVAILABLE
  follow-up-nudge   Remind on stale threads     AVAILABLE

  This week: 1,247 signals ingested. Top: email (47%), voice (23%), X (18%).
  34 new entity pages created. 7 calls transcribed.

  Run 'voltmind integrations show <id>' for setup details.
```

用户感受到的是：“我的 brain 活起来了。它在看着我关心的一切，而且每天都更聪明。我不用写任何代码。agent 问我时我只要说 yes。”

## 架构：Senses 与 Reflexes

### Recipe 格式（YAML frontmatter + markdown body）

```yaml
---
id: voice-to-brain
name: Voice-to-Brain
version: 0.7.0
description: Phone calls create brain pages via Twilio + OpenAI Realtime + VoltMind MCP
category: sense
requires: [credential-gateway]
secrets:
  - name: TWILIO_ACCOUNT_SID
    description: Twilio account SID
    where: https://console.twilio.com
  - name: OPENAI_API_KEY
    description: OpenAI API key (for Realtime voice)
    where: https://platform.openai.com/api-keys
health_checks:
  - curl -s https://api.twilio.com/2010-04-01 > /dev/null
  - curl -s https://api.openai.com/v1/models > /dev/null
setup_time: 30 min
---

[Opinionated setup instructions the agent executes...]
```

### Dependency Graph

Recipes 在 frontmatter 中声明 `requires`。CLI 会在 setup 前解析依赖。如果 voice-to-brain 需要 credential-gateway，agent 会先设置 credential-gateway。

```
credential-gateway
  ├── voice-to-brain (requires credentials for Twilio)
  ├── email-to-brain (requires credentials for Gmail)
  └── calendar-to-brain (requires credentials for Google Calendar)

x-to-brain (standalone, uses X API directly)
```

### Health Dashboard

`voltmind integrations doctor` 运行每个已配置 recipe 的 health_checks：
```
$ voltmind integrations doctor
  voice-to-brain:   ✓ Twilio reachable  ✓ OpenAI key valid  ✓ ngrok tunnel up
  email-to-brain:   ✓ Gmail auth valid   ✗ No emails in 48h (check cron)
  OVERALL: 1 warning
```

### Sense Analytics

`voltmind integrations stats` 聚合 heartbeat 数据：
```
$ voltmind integrations stats
  This week: 1,247 signals ingested
  Top sources: email (47%), voice (23%), X (18%), calendar (12%)
  34 new entity pages created
  7 calls transcribed
  Brain growth: 12,400 → 12,834 pages (+434)
```

### Reflex Rules Engine（未来）

Reflexes 是由 brain state change 触发的 recipe：

```yaml
---
id: deal-tracker
category: reflex
triggers:
  - type: page_updated
    filter: {type: deal, field: status}
  - type: timeline_entry
    filter: {source: email, mentions: deal}
action: alert
---

When a deal page's status changes or a new email mentions a deal,
alert the user with context from the brain.
```

## Roadmap

| Version | What Ships | Key Recipe |
|---------|-----------|------------|
| v0.7.0 | Recipe format, CLI, SKILLPACK breakout | voice-to-brain |
| v0.8.0 | 3 more senses, reflex format | email, X, calendar |
| v0.9.0 | Community recipes, install executor | community submissions |
| v1.0.0 | Full senses/reflexes, health dashboard | meeting-prep, dream-cycle |

## 关键设计决策

1. **VoltMind 是确定性基础设施。** 跨 sense 关联、模式检测、智能响应是 agent（OpenClaw/Hermes）的工作。VoltMind 提供 plumbing。

2. **Agents 就是 runtime。** 没有 npm package、Docker image 或确定性脚本。Recipe markdown 本身就是 installer。Agent 读取它并执行工作。

3. **非常 opinionated 的默认值。** 默认 ship creator 精确的生产设置。用户从那里开始定制。未知来电会被筛查。Quiet hours 会被强制。每通电话都先查 brain。

4. **Agent-readable outputs。** 所有 CLI 输出必须可被 agent 解析（`--json` flag）。Migration files 包含 agent instructions。主要消费者是 agent，不是人类。
