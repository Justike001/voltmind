# Source Attribution

## 目标
brain 中每个事实都能追溯来源：谁说的、在什么上下文、什么时候。

## 用户得到什么
没有它：半年后没人知道 “Pedro co-founded Brex” 来自 Pedro 本人、LinkedIn 抓取还是幻觉。有了它：每个 claim 可审计，冲突会浮现，brain 成为现实记录。

## 实现

~~~
on brain_write(page, fact):
    citation = format_citation(source)
    # format: [Source: {who}, {channel/context}, {date} {time} {tz}]
    voltmind put <slug> --content "...fact [Source: ...]..."
    if conflicts_exist(fact, existing_page):
        append_to_compiled_truth("Conflict: Source A says X, Source B says Y. [Source: A] [Source: B]")
~~~

## 容易踩坑的地方

1. **compiled truth 也需要 citations。** above the bar 不能豁免。
2. **Tweet URLs 必须有。** 只有 `@handle` 是坏引用。
3. **“User said it” 不够。** 要有地点/上下文/时间。
4. **不要静默解决冲突。** 同时记录两方来源。
5. **timeline 条目也要 source。** 无 source 的 timeline 是孤儿事实。

## 如何验证

1. 打开任意 brain page，compiled truth 中 factual claims 应有 `[Source: ...]`。
2. 搜索 `voltmind search "X/@"`，tweet references 应有完整 URL。
3. 多来源页面应分别引用每个来源。
4. 随机 3 个页面 timeline 条目应有日期和上下文。
5. 用户说法与 API 冲突时，应显式记录矛盾。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
