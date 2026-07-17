# Search Modes

## 目标
知道何时使用 keyword、hybrid 或 direct 搜索，让每次 lookup 都快速且返回正确结果。

## 用户得到什么
没有它：agent 在 search commands 间乱选，需要完整页面时返回 chunks，直接 get 就够时跑昂贵 semantic search，甚至漏结果。有了它：每次 lookup 使用最优模式，token budget 得到控制。

## 实现

~~~
on user_asks_about(topic):
    if know_exact_slug(topic):
        result = voltmind get <slug>
    elif topic.is_exact_name or topic.is_keyword:
        results = voltmind search "{name_or_keyword}"
        if chunk.confirms_relevance:
            full_page = voltmind get <slug_from_chunk>
    elif topic.is_semantic_question:
        results = voltmind query "{natural language question}"
        if chunk.confirms_relevance:
            full_page = voltmind get <slug_from_chunk>
~~~

## 容易踩坑的地方

1. **search 返回 chunks，不是 full pages。** chunk 只用于判断相关性，必要时再 `voltmind get <slug>`。
2. **keyword search 不需要 embeddings。** 第一天也能用。
3. **已知名字不要用 hybrid。** `voltmind search` 或已知 slug 时 `voltmind get` 更好。
4. **注意 token budget。** 先看 chunks，再决定是否拉整页。
5. **hybrid 需要 embeddings。** query 无结果但 search 有结果，通常是 embeddings 未生成。

## 如何验证

1. `voltmind search "Pedro"` 应返回匹配 chunks 和 slug。
2. `voltmind query "who works at fintech companies"` 应返回语义相关结果。
3. `voltmind get pedro-franceschi` 应返回完整页面。
4. 同一实体用三种模式比较。
5. search 返回 chunk 后，对 slug 再 `voltmind get`，应看到更多上下文。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
