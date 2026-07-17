# 确定性 Collectors：代码处理数据，LLM 负责判断

## 目标

把机械工作（100% 可靠的代码）和分析工作（LLM 判断）分开，避免确定性任务被概率性失败拖垮。

## 用户得到什么

没有它：LLM 生成 Gmail 链接、格式化表格、追踪状态，前 10 项遵守规则，第 11 项漏链接。写再多 “NO EXCEPTIONS” 也没用。

有了它：代码处理 URL、格式和状态；LLM 读取预格式化数据，只做判断、分类和 enrichment。链接永远不会错，因为 LLM 不生成链接。

## 实现

~~~
// The pattern: code collects, LLM analyzes
collector_run():
  messages = gmail_api.fetch_unread()
  for msg in messages:
    structured = {
      id: msg.id,
      from: msg.sender,
      subject: msg.subject,
      snippet: msg.snippet,
      gmail_link: f"https://mail.google.com/mail/u/?authuser={account}#inbox/{msg.id}",
      gmail_markdown: f"[Open in Gmail]({gmail_link})",
      is_signature: regex_match(msg, DOCUSIGN_PATTERNS),
      is_noise: regex_match(msg, NOISE_PATTERNS),
      is_new: msg.id not in state.seen_ids
    }
    store(structured)
    state.seen_ids.add(msg.id)
  generate_markdown_digest(structured_messages)

llm_analyze():
  digest = read("data/digests/today.md")
  classify_urgency(digest)
  add_commentary(digest)
  run_brain_enrichment(notable_entities)
  draft_replies(urgent_items)
  surface_to_user(final_output)
~~~

### 架构

~~~
+-----------------------------+     +------------------------------+
|  Deterministic Collector    |---->|       LLM Agent              |
|  - Pull data from API       |     |  - Classify items            |
|  - Store structured JSON    |     |  - Add commentary            |
|  - Generate links/URLs      |     |  - Run brain enrichment      |
|  - Track state              |     |  - Draft replies             |
+-----------------------------+     +------------------------------+
~~~

### 文件结构

~~~
scripts/email-collector/
├── email-collector.mjs
├── data/
│   ├── state.json
│   ├── messages/
│   └── digests/
~~~

### 适用场景

| Signal Source | Collector 生成 | LLM 添加 |
|--------------|-------------------|----------|
| **Email** | Gmail links、sender metadata、signature detection | urgency、enrichment、reply drafts |
| **X/Twitter** | Tweet links、engagement metrics、deletion detection | sentiment、narrative、content ideas |
| **Calendar** | Event links、attendees、conflict detection | prep briefings、brain context |
| **Slack** | Channel/thread links、mention detection | priority、action items |
| **GitHub** | PR/issue links、diff stats、CI status | review context、priority |

### 原则

必须存在且格式必须正确的输出，用代码生成。需要判断、上下文或创造力的输出，用 LLM 生成。不要在同一轮里要求 LLM 同时做两者。

## 容易踩坑的地方

1. **LLM 会忘链接，代码要提前烤进去。** 长输出里的概率性格式必然漏项。
2. **噪声过滤必须确定性。** regex 归 collector，LLM 分类会漂移。
3. **原子写避免损坏。** 先写 temp file，再 rename，避免 state 或 digest 半写入。

## 如何验证

1. 手动运行 collector，检查每个 `[Open in Gmail]` 链接。
2. 同一输入跑两遍，`is_noise` 必须一致。
3. 全链路运行后，最终输出里的链接应与 digest 文件完全一致。

---

*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
