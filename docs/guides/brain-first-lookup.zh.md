# Brain-First 查询协议

## 目标

在调用任何外部 API 之前先检查 brain。brain 几乎总有线索；外部 API 只负责补缺口，而不是从零开始。

## 用户得到什么

没有它：agent 会为一个你已经开过 12 次会的人去 Brave Search，返回 LinkedIn 摘要而不是关系历史。

有了它：agent 先拉取 compiled truth、近期 timeline 和共同上下文，再决定是否需要外部 API。

## 实现

~~~
lookup(name_or_topic):
  // STEP 1: Keyword search (fast, works day one, no embeddings needed)
  results = voltmind search "{name_or_topic}"
  if results.length > 0:
    page = voltmind get {results[0].slug}
    return page  // done, brain had it

  // STEP 2: Hybrid search (needs embeddings, finds semantic matches)
  results = voltmind query "what do we know about {name_or_topic}"
  if results.length > 0:
    page = voltmind get {results[0].slug}
    return page

  // STEP 3: Direct slug (if you know or can guess the slug)
  page = voltmind get "people/{slugify(name_or_topic)}"
  if page: return page

  // STEP 4: External API (FALLBACK ONLY)
  // Only reach here if brain has nothing
  return external_search(name_or_topic)
~~~

**这是强制规则。** 在检查 brain 前就调用 Brave Search 的 agent，会浪费钱，也会给出更差的答案。

## 为什么 Brain 优先

brain 有外部 API 没有的上下文：
- 关系历史：你怎么认识他们、讨论过什么
- 你自己的评估：你的判断，而不是对方公开资料
- 会议记录：说过什么、决定过什么
- 交叉引用：他们认识谁、关联哪些公司
- 时间线：最近有什么变化、趋势是什么

LinkedIn 抓取只给职位；brain 会给关系、历史、兴趣点和你自己的判断。

## 容易踩坑的地方

1. **先 keyword，再 hybrid。** Keyword 不需要 embeddings；hybrid 能找语义匹配。按顺序尝试。
2. **用 fuzzy slug matching。** `voltmind get` 会提示相近 slug，可处理 “Pedro” 与 “pedro-franceschi” 这类变体。
3. **“简单”问题也要先查。** brain 查询开销很低，而且可能已经有答案。
4. **加载 compiled truth + recent timeline。** 前者给当前判断，后者给最近变化。

## 如何验证

1. 问 brain 中已有的人，确认 agent 先查 brain。
2. 问 brain 中没有的人，确认先查 brain，没命中后才外部搜索。
3. 同一个问题问两次，第二次应该更快。

---

*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。另见：[Brain-Agent Loop](brain-agent-loop.md)、[Search Modes](search-modes.md)*
