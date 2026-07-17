# Originals Folder

## 目标
用用户原话、深度 cross-links 和完整 provenance 捕获原创思考，让 intellectual capital 复利而不是蒸发。

## 用户得到什么
没有它：对话中生成的框架在 session 结束后消失。六个月后只剩模糊记忆。有了它：每个原创观察、thesis、framework、hot take 都逐字进入 `brain/originals/`，并关联塑造它的人、公司和媒体。

## 实现

~~~
on user_message(message):
    if contains_original_thinking(message):
        slug = slugify(user_exact_phrase)
        voltmind put originals/{slug} --content "..."
        for entity in idea.influences:
            voltmind add_link originals/{slug} <entity_slug>
            voltmind add_link <entity_slug> originals/{slug}
        voltmind sync
~~~

## 容易踩坑的地方

1. **命名：生动性就是概念。** 不要把 `meatsuit-maintenance-tax` 洗成企业化短语。
2. **Synthesis IS original。** 用户对他人框架的理解、解释或反对进入 `originals/`。
3. **没有 cross-links 的 original 是死的。** 连接才是 intelligence。
4. **Originals 会形成 clusters。** 把 originals 彼此链接起来。
5. **捕获触发上下文。** 是哪次对话、会议、文章或时刻激发了它？

## 如何验证

1. 生成原创想法后，`voltmind get originals/ambition-debt` 应能看到页面。
2. 标题和 slug 应使用用户原话。
3. `voltmind get_links originals/ambition-debt` 应有关联。
4. 对他人想法的原创 take 应进 `originals/` 而不是 `concepts/`。
5. `voltmind search "ambition debt"` 应能找到。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
