# Sub-Agent Model Routing

## 目标
把 sub-agents 路由到能完成任务的最便宜模型，在不牺牲质量的情况下降低 10-40x 成本。

## 用户得到什么
没有它：所有 sub-agent 都跑 Opus，entity detection 每天花 $3-5，research 每次 $10+。有了它：detection 跑 Sonnet，research 跑 DeepSeek，主 session 留在 Opus，总成本下降 70-80%。

## 实现

### Routing Table

| Task Type | Recommended Model | Why |
|-----------|------------------|-----|
| Main session / complex instructions | Opus-class | 最强 reasoning 和 instruction following |
| Research / synthesis / analysis | DeepSeek V3 or equivalent | 便宜很多，适合探索工作 |
| Structured output / long context | Large context model | 长上下文、JSON 稳定 |
| Fast lightweight sub-agents | Fast inference model | 快且便宜 |
| Deep reasoning | Reasoning model | 难题用，昂贵 |
| Entity detection | Sonnet-class | 快、便宜、质量足够 |

### Signal Detector Pattern

~~~
on_every_message(text):
  spawn_subagent({ task: "SIGNAL DETECTION...", model: "sonnet-class", timeout: 120s })
~~~

### Research Pipeline Pattern

~~~
1. PLANNING (Opus)
2. EXECUTION (DeepSeek)
3. SYNTHESIS (Opus)
~~~

### When to Spawn Sub-Agents

| Situation | Spawn? | Model |
|-----------|--------|-------|
| Every inbound message | YES | Sonnet |
| Research request | YES | DeepSeek |
| Quick lookup / fact check | YES | Fast model |
| Complex analysis | NO | Opus |
| Writing / editing | NO | Opus |

## 容易踩坑的地方

1. **detection 用 Sonnet，不用 Opus。** 它是模式匹配。
2. **不要阻塞主线程。** sub-agents 必须异步。
3. **成本优化是乘法效应。** 每条消息都跑的任务选错模型，月成本会显著上升。

## 如何验证

1. 发送消息，确认 signal detector 用 Sonnet-class。
2. 对比启用 routing 前后的日成本，应下降 50-80%。
3. 响应应在 5 秒内到达；30+ 秒说明 detector 阻塞主线程。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
