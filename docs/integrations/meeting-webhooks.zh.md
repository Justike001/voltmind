# Meeting & Call Webhooks

### 14b. Circleback -- Meeting Ingestion via Webhooks

[Circleback](https://circleback.ai) 会录制会议、生成带 speaker diarization
的 transcripts，并在完成时触发 webhooks。

**Webhook setup:**

1. In Circleback dashboard -> Automations -> add webhook
2. URL: `{your_agent_gateway}/hooks/circleback-meetings`
3. Circleback provides a signing secret for HMAC-SHA256 signature verification
4. Store the signing secret in your webhook transform for verification

**Webhook payload:** 会议 JSON，包含 id、name、attendees、notes、action items、
完整 transcript、calendar event context。

**Signature verification:** Header `X-Circleback-Signature` 包含
`sha256=<hex>`。使用 `HMAC-SHA256(body, signing_secret)` 验证。拒绝未验证的
webhooks。

**OAuth for API access:** Circleback 使用 dynamic client registration
（OAuth 2.0）。Access tokens 约 24h 过期，通过 refresh token 自动刷新。
将 credentials 存入 agent memory。

**Flow:** Webhook fires -> transform validates signature + normalizes -> agent wakes ->
pulls full transcript via API -> creates brain meeting page -> propagates to entity
pages -> commits to brain repo -> `voltmind sync`。

### 14c. Quo (OpenPhone) -- SMS and Call Integration

[Quo](https://openphone.com)（原 OpenPhone）提供带 SMS、calls、voicemail
和 AI transcripts 的商务电话号码。

**Webhook setup:**

1. In Quo dashboard -> Integrations -> Webhooks
2. Register webhooks for: `message.received`, `call.completed`, `call.summary.completed`, `call.transcript.completed`
3. Point all to: `{your_agent_gateway}/hooks/quo-events`
4. Store registered webhook IDs in agent memory

**How inbound texts work:**

- Webhook 带 sender phone、message text、conversation context 触发
- Agent 按电话号码在 brain 中查找 sender
- 带 sender identity + brain context 推送到用户的消息平台
- 起草回复供审批（没有明确许可绝不自动回复）

**How inbound calls work:**

- `call.completed` 触发 -> 如果 duration > 30s，通过 API 拉取 transcript + AI summary
- 写入 brain（`meetings/` 下的 meeting-style page）
- 更新相关 people 和 company pages

**API auth:** `Authorization` header 中的裸 API key（无 Bearer 前缀）。

**Key endpoints:** `POST /v1/messages`（send SMS）、`GET /v1/messages`（list）、
`GET /v1/call-transcripts/{id}`、`GET /v1/conversations`。

---

---

*Part of the [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md). See also: [Getting Data In](README.md)*
