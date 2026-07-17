# Brain-Agent 循环

## 目标

每一次对话都会让 brain 更聪明。每一次 brain 查询都会让回复更好。这个循环每天都会复利增长。

## 用户得到什么

没有它：agent 只能基于陈旧上下文回答。你周一讨论了一笔交易，到了周五 agent 已经忘了。每次对话都从零开始。

有了它：六个月后，agent 对你世界的了解会超过你工作记忆能承载的量。它不会遗忘，也不会停止索引。

## 循环

```
Signal arrives (message, meeting, email, tweet, link)
  │
  ▼
DETECT entities (people, companies, concepts, original thinking)
  │  → spawn sub-agent (see entity-detection.md)
  │
  ▼
READ: check brain FIRST (before responding)
  │  → voltmind search "{entity name}"
  │  → voltmind get {slug} (if you know it)
  │  → voltmind query "what do we know about {topic}"
  │
  ▼
RESPOND with brain context (every answer is better with context)
  │
  ▼
WRITE: update brain pages (new info → compiled truth + timeline)
  │  → voltmind put {slug} (update page)
  │  → add_timeline_entry (append to timeline)
  │  → add_link (cross-reference to other entities)
  │
  ▼
SYNC: voltmind indexes changes
  │  → voltmind sync --no-pull --no-embed
  │
  ▼
(next signal arrives — agent is now smarter)
```

## 实现

### 每条入站消息

```
on_message(text):
  // 1. DETECT (async, don't block)
  spawn_entity_detector(text)

  // 2. READ (before composing response)
  entities = extract_entity_names(text)  // quick regex/NER
  context = []
  for name in entities:
    results = voltmind_search(name)
    if results:
      page = voltmind_get(results[0].slug)
      context.append(page.compiled_truth)

  // 3. RESPOND (with brain context injected)
  response = compose_response(text, context)

  // 4. WRITE (after responding, if new info emerged)
  if response_contains_new_info(response):
    for entity in mentioned_entities:
      voltmind_add_timeline_entry(entity.slug, {
        date: today,
        summary: "Discussed {topic}",
        source: "[Source: User, conversation, {date}]"
      })

  // 5. SYNC
  voltmind_sync()
```

### 两个不变量

1. **每一次 READ 都会改善回复。** 如果你在回答关于某个人的问题前没有先查他的 brain 页面，你给出的答案就比本可以给出的更差。brain 几乎总有一些东西。外部 API 是补空白，不是从零开始。

2. **每一次 WRITE 都会改善未来的读取。** 如果会议记录提到了某家公司的一条新信息，而你没有更新公司页面，你就制造了一个以后会反噬你的缺口。

## 容易踩坑的地方

1. **先读再回复，不要反过来。** 很容易想先回复、之后再更新 brain。但 brain 上下文会让回复更好，所以先读。

2. **不要跳过写入步骤。** “我等会儿再更新 brain”通常意味着永远不会。对话结束后趁上下文还新鲜，立刻写入。

3. **每批写入后都要 sync。** 不 sync，brain 搜索索引就是旧的。下一次查询找不到你刚写进去的内容。

4. **外部 API 是兜底，不是主路径。** 先 `voltmind search`，再 Brave Search。先 `voltmind get`，再 Crustdata。brain 有关系历史、你自己的判断、会议记录、交叉引用。这些不是任何外部 API 能提供的。

## 如何验证它有效

1. **提到一个 brain 已知的人。** 问 “what do we know about {name}?” agent 应该搜索 brain 并返回 compiled truth，而不是幻觉或做网页搜索。

2. **讨论一个已知实体的新信息。** 比如说 “I heard Acme Corp just raised Series B.” 对话后检查：Acme Corp 的 brain 页面是否有新的 timeline 条目？

3. **隔天再问同一个人。** agent 应该不需要你提醒就立即拉取 brain 上下文。如果它没有引用 brain 页面，说明循环没有运行。

4. **检查 sync。** 对话后从 CLI 运行 `voltmind search "{topic}"`。新信息应该可以被搜索到。

---

*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。另见：[Entity Detection](entity-detection.md)、[Brain-First Lookup](brain-first-lookup.md)*
