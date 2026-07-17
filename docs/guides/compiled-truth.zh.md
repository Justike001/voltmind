# Compiled Truth + Timeline 模式

## 目标

每个 brain 页面都有两个区域：compiled truth（当前综合，随证据变化而重写）和 timeline（只追加的证据轨迹，永不编辑）。

## 用户得到什么

没有它：页面变成追加日志，答案埋在第 147 条里。有了它：compiled truth 让你 30 秒掌握当前判断，timeline 提供证据链。

## 实现

### 页面结构

~~~markdown
---
type: person
title: Sarah Chen
tags: [engineering, acme-corp]
---

## Executive Summary
One paragraph. How you know them, why they matter.

## State
VP Engineering at Acme Corp. Managing 45-person team. Reports to CEO.

## What They Believe
Strong opinions on test coverage. "Ship it when the tests pass, not before."

## What They're Building
Leading the API migration from REST to GraphQL. Target: Q3 completion.

## Assessment
Sharp technical leader. Under-appreciated internally. Watch for signs of burnout.

## Trajectory
Ascending. Likely CTO track if the migration succeeds.

## Relationship
Met through Pedro. Had coffee 3x. Last: discussed API architecture thesis.

## Contact
sarah@acmecorp.com | @sarahchen | linkedin.com/in/sarahchen

---

## Timeline

- **2026-04-07** | Met at team sync. Discussed API migration timeline.
  Seemed energized about GraphQL pivot.
  [Source: Meeting notes, 2026-04-07 2:00 PM PT]
~~~

### 更新页面

~~~
update_brain_page(slug, new_info, source):
  page = voltmind get {slug}
  voltmind add_timeline_entry {slug} { ... }
  updated_truth = rewrite_compiled_truth(page.compiled_truth, new_info)
  voltmind put {slug} { compiled_truth: updated_truth }
~~~

### 规则

| 区域 | 动作 | 说明 |
|------|--------|-------------|
| Compiled truth | **重写** | 当前综合。证据变化时更新。 |
| Timeline | **追加** | 证据轨迹。永不编辑，只新增。 |

**每个 compiled truth 声明都必须能追溯到 timeline 条目。**

## 容易踩坑的地方

1. **REWRITE 是重写，不是追加。** 把新信息整合进整段综合，而不是在后面加补丁。
2. **Timeline 条目不可变。** 错误用新条目更正，不改旧条目。
3. **VoltMind 搜索更重视 compiled truth。** 最新综合会优先出现。
4. **`---` 分隔符很重要。** 它切分 compiled_truth 和 timeline。
5. **不要跳过 Assessment。** 你的判断是页面区别于 LinkedIn 的价值。

## 如何验证

1. 更新人物页：compiled truth 应被重写，timeline 顶部应有新条目。
2. `voltmind query "Sarah Chen"` 应优先显示 compiled truth。
3. compiled truth 的声明应能在 timeline 中找到证据。
4. 更新后旧 timeline 条目应完全不变。

---

*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。另见：[Source Attribution](source-attribution.md)、[Entity Detection](entity-detection.md)*
