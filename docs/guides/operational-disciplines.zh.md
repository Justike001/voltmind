# Operational Disciplines

## 目标
五条不可协商的规则：每条消息做 signal detection、brain-first lookup、每次写后 sync、daily heartbeat、nightly dream cycle。

## 用户得到什么
没有它：agent 漏掉对话信号，brain 已有答案时仍浪费外部 API，写入后搜索陈旧，brain 悄悄腐烂。有了它：每条消息都扫描实体，brain 总是先被咨询，搜索总是当前，健康每日监控，夜间复利。

## 实现

~~~
# DISCIPLINE 1: Signal Detection on Every Message
# DISCIPLINE 2: Brain-First Lookup Before External APIs
# DISCIPLINE 3: Sync After Every Write
# DISCIPLINE 4: Daily Heartbeat Check
# DISCIPLINE 5: Nightly Dream Cycle
~~~

## 容易踩坑的地方

1. **dream cycle 最重要。** 它修 broken graph、查无来源事实、更新 compiled truth。
2. **跳过 sync after write 会导致搜索陈旧。** 页面存在但不可搜。
3. **signal detection 必须每条消息都跑。** 路过的一句话也可能是 timeline 条目。
4. **brain-first 省钱且答案更好。** brain 有私有关系和会议上下文。
5. **`voltmind doctor` 能抓静默失败。** embedding、sync、DB 都可能悄悄坏。

## 如何验证

1. 提到已有 brain 页的人，确认 timeline 新增条目。
2. 问 brain 中的人，确认先 `voltmind search` 或 `voltmind get`。
3. `voltmind put` 后立即 search，应能搜到。
4. `voltmind doctor` 应返回健康报告。
5. dream cycle 后，未链接实体应新增 links。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
