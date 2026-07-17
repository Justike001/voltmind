# Credential Gateway (ClawVisor / Hermes)


三个让 agent 真正可用的集成。没有这些，brain 只是一个静态数据库。
有了它们，brain 才是活的。

### 14a. Credential Gateway (ClawVisor / Hermes Gateway)

EA workflow 需要 Gmail、Calendar、Contacts 和消息访问权限。agent
绝不应该直接持有 API keys。请使用 credential gateway，在请求时强制执行策略并注入凭据。

**OpenClaw: ClawVisor。** [ClawVisor](https://clawvisor.com) 是一个带
task-scoped authorization 的凭据保险库和授权网关。

**Services:** Gmail（list、read、send、draft）、Google Calendar（CRUD）、
Google Drive（list、search、read）、Google Contacts（list、search）、
Apple iMessage（list、read、search、send）、GitHub、Slack。

**Task-scoped authorization:** 每个请求都必须包含来自已批准 standing task 的
`task_id`。Task 会声明：purpose（详细，2-3 句话）、带预期使用模式的授权动作、
auto-execute 标志、lifetime（standing vs ephemeral）。

**Why this matters for VoltMind:** EA workflow 需要 Gmail（triage 前做 sender lookup）、
Calendar（会议准备、attendee pages）、Contacts（enrichment trigger）和
iMessage（直接指令）。ClawVisor 让 agent 获得访问能力，但不把原始凭据交给它。

**Setup:**

1. 在 ClawVisor dashboard 中创建 agent，复制 agent token
2. 在 env 中设置 `CLAWVISOR_URL` 和 `CLAWVISOR_AGENT_TOKEN`
3. 在 dashboard 中激活 services（Google、iMessage 等）
4. 创建 scope 宽泛的 standing tasks（目的过窄会导致误拦截）
5. 将 standing task IDs 存入 agent memory，便于复用

**Critical scoping rule:** task purposes 要写得宽泛。"Full executive assistant
email management including inbox triage, searching by any criteria, reading emails,
tracking threads" 可行。"Email triage" 会被拒。intent verification model
会用 purpose 判断每个请求是否一致 -- 如果 purpose 过窄，合法请求也会验证失败。

**Hermes Agent: Built-in gateway。** Hermes 的 gateway 内置多平台消息
（Telegram、Discord、Slack、WhatsApp、Signal、Email）和 tool access。使用
`config.yaml` 配置 API credentials。gateway daemon 管理连接，并将 webhooks
路由到 agent sessions。对于 Google services，在 gateway config 中配置 OAuth
credentials。Hermes 的 scheduled automations 可以通过 gateway 的 tool system
运行同样的 EA workflows（email triage、calendar prep、contact enrichment）。

---

*Part of the [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md). See also: [Getting Data In](README.md)*
