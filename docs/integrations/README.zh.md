# Getting Data Into Your Brain

VoltMind 是 retrieval layer。但检索质量取决于你放进去的内容。本目录说明如何让数据自动流入你的 brain。

## How Data Flows In

```
Signal arrives (phone call, email, tweet, calendar event)
  ↓
Collector captures it (deterministic code, reliable)
  ↓
Agent analyzes it (LLM, judgment, entity detection)
  ↓
Brain pages created/updated (compiled truth + timeline)
  ↓
VoltMind indexes it (chunking, embedding, search-ready)
  ↓
Next query is smarter (the compounding effect)
```

## Available Integrations

### Self-Installing Recipes

这些是 agent 可以为你设置的 integration recipes。运行 `voltmind integrations`
查看可用项及其状态。

| Recipe | Category | Requires | What It Does | Setup Time |
|--------|----------|----------|-------------|------------|
| [ngrok-tunnel](../../recipes/ngrok-tunnel.md) | Infra | — | MCP + voice 的固定公网 URL（$8/mo） | 10 min |
| [credential-gateway](../../recipes/credential-gateway.md) | Infra | — | Gmail + Calendar access（ClawVisor 或 Google OAuth） | 15 min |
| [voice-to-brain](../../recipes/twilio-voice-brain.md) | Sense | ngrok-tunnel | 电话通过 Twilio + OpenAI Realtime 创建 brain pages | 30 min |
| [email-to-brain](../../recipes/email-to-brain.md) | Sense | credential-gateway | Gmail messages 通过 deterministic collector 流入 entity pages | 20 min |
| [x-to-brain](../../recipes/x-to-brain.md) | Sense | — | Twitter timeline、mentions、keyword monitoring，带 deletion detection | 15 min |
| [calendar-to-brain](../../recipes/calendar-to-brain.md) | Sense | credential-gateway | Google Calendar events 成为可搜索的 daily brain pages | 20 min |
| [meeting-sync](../../recipes/meeting-sync.md) | Sense | — | Circleback meeting transcripts 自动导入并传播到 attendees | 15 min |

### Manual Integration Guides

这些需要手动设置（还没有 self-installing recipe）：

| Guide | What It Does |
|-------|-------------|
| [Credential Gateway](credential-gateway.md) | 为 Gmail、Calendar、Contacts access 设置 ClawVisor 或 Hermes |
| [Meeting & Call Webhooks](meeting-webhooks.md) | Circleback meeting transcripts + Quo/OpenPhone SMS/calls |

## How to Read a Recipe

Integration recipes 是带 YAML frontmatter 的 markdown files。你的 agent 会读取
recipe 并带你完成 setup。

```yaml
---
id: voice-to-brain              # unique identifier
name: Voice-to-Brain            # human-readable name
version: 0.7.0                  # recipe version
description: Phone calls...     # what it does
category: sense                 # sense (data input) or reflex (automated response)
requires: []                    # other recipes that must be set up first
secrets:                        # API keys and credentials needed
  - name: TWILIO_ACCOUNT_SID
    description: Twilio account SID
    where: https://console.twilio.com    # exact URL to get this key
health_checks:                  # typed DSL to verify the integration is working
  - type: http
    url: "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID.json"
    auth: basic
    auth_user: "$TWILIO_ACCOUNT_SID"
    auth_token: "$TWILIO_AUTH_TOKEN"
    label: "Twilio account"
setup_time: 30 min              # estimated time to complete setup
---

[Setup instructions the agent follows step by step...]
```

**The recipe IS the installer.** 你的 agent（OpenClaw、Hermes、Claude Code）
会读取 markdown body 并执行 setup steps。它会向你索取 API keys、验证每个 key、
配置 integration，并运行 smoke test。

### Recipe trust boundary

只有 voltmind package 自带的 recipes（source install 中的 `recipes/` 目录，
或 global install copy）是可信的。运行时从 `$VOLTMIND_RECIPES_DIR` 或 cwd-local
`./recipes/` 发现的 recipes 会被标为 untrusted：它们不能运行 `command`
health checks，不能运行 `http` health checks（SSRF defense），也不能使用已废弃的
string health_check form。Untrusted recipes 仍然可以使用 `env_exists` 和
`any_of` compositions。若要发布会运行 live checks 的 recipe，请 upstream
贡献，使其成为 package-bundled。

## The Deterministic Collector Pattern

当 LLM 在某个机械任务上反复失败，即便多次改 prompt 也不行时，不要继续和 LLM 较劲。
把机械工作移到代码里。

**Code for data. LLMs for judgment.**

- Email collection：代码拉取带内嵌 links 的 emails（100% reliable）。
  LLM 读取 digest，分类，并 enrich brain entries（judgment）。
- Tweet collection：代码拉取 timeline、检测 deletions、跟踪 engagement
  （deterministic）。LLM 提取 entities、写入 brain updates（judgment）。
- Calendar sync：代码拉取 events 和 attendees（deterministic）。LLM enrich
  attendee brain pages（judgment）。

这个模式避免了 “LLM forgot the links” 失败模式。机械工作必须 100% reliable。
Judgment work 才是 LLM 擅长的地方。

完整模式见 [Deterministic Collectors](../guides/deterministic-collectors.md)。

## Architecture

关于所有 integrations 构建其上的共享 infrastructure（import pipeline、chunking、
embedding、search），见
[Infrastructure Layer](../architecture/infra-layer.md)。

关于 thin harness + fat skills 背后的哲学，见
[Thin Harness, Fat Skills](../ethos/THIN_HARNESS_FAT_SKILLS.md)。
