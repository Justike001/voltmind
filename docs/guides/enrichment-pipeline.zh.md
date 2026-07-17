# Enrichment Pipeline

## 目标
通过分层开销从外部 API enrich brain 页面：关键人物走完整 pipeline，路过提及轻量处理，原始数据保留以便审计。

## 用户得到什么
没有它：brain 页面只有用户手输的薄壳，API 调用浪费在无关人物上，enrichment 数据随 agent session 消失。有了它：关键人物有多源画像，开销随重要性缩放，原始 API 响应可重新处理，交叉引用连接全图。

## 实现

~~~
on enrich(entity, trigger):
    entities = extract_entities(signal)
    for entity in entities:
        existing = voltmind search "{entity.name}"
        path = "UPDATE" if existing else "CREATE"
    tier = classify_tier(entity)
    data["brain"] = voltmind search "{entity.name}"
    if tier <= 2: data["web"] = brave_search("{entity.name}")
    if tier == 1: data["linkedin"] = crustdata_enrich(entity.name)
    voltmind put_raw_data <entity_slug> --data '{"sources": {...}}'
    voltmind add_link <person_slug> <company_slug>
~~~

## 容易踩坑的地方

1. **不要覆盖用户写的 Assessment。** API 数据进 State、Contact、Timeline；用户判断是神圣的。
2. **同一页一周内不要重复 enrich。** 先查 `put_raw_data` 时间戳。
3. **LinkedIn connections < 20 基本是错人。** 丢弃低可信匹配。
4. **X/Twitter 被低估。** handle 能揭示信念、在建事项、社交网络和轨迹变化。
5. **交叉引用不是可选项。** enrich 人物后更新公司页，enrich 公司后更新 founder 页。

## 如何验证

1. enrich Tier 1 人物后，`voltmind get <slug>` 应有多源填充的核心 section。
2. `voltmind get_raw_data <slug>` 应有 `sources.{provider}.fetched_at`。
3. `voltmind get_links <slug>` 应有关联公司、deal 和实体。
4. 用户写过的 Assessment 不应被覆盖。
5. 一周内重复 enrich 应被跳过。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
