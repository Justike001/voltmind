# Skill Development Cycle

## 目标

把每个重复任务变成持久、自动化的 skill：如果你问第二次，它就应该已经在 cron 上运行。

## 用户得到什么

没有它：ad-hoc 工作会被 agent 忘掉，每次 enrichment 都重新发明流程。有了它：每项能力都被 codify、测试和调度，质量稳定，新模式一天内 skill-ify。

## 实现

**规则：** 同一件事需要问 agent 两次，就应该变成 skill 并上 cron。第一次是探索；第二次是系统失败。

### 5-Step Cycle

**Step 1: Concept the Process.** 用普通语言描述输入、输出、触发器、数据源和频率。

**Step 2: Run Manually for 3-10 Items.** 先小批量手动做，不要急着写 `SKILL.md`。

**Step 3: Evaluate Output.** 给用户看结果，收反馈，修流程。

**Step 4: Codify into a Skill.** 写 `SKILL.md`，新能力建新 skill，已有能力的变体扩展现有 skill。

**Step 5: Add to Cron (if recurring).** 适合自动运行就加入 cron，并观察前 2-3 次自动运行。

### MECE Discipline

Skills 应该 Mutually Exclusive, Collectively Exhaustive：每种 entity type 和 signal source 都只有一个 owner skill，两个 skill 创建同一页面就是 violation。

### Quality Bar Checklist

- [ ] 在 3-10 个真实 items 上成功运行
- [ ] 用户审阅并认可
- [ ] `SKILL.md` 少于 500 行
- [ ] 创建页面前检查 notability
- [ ] 有 citation enforcement
- [ ] 不与现有 skills 重叠
- [ ] recurring 时已上 cron
- [ ] 创建 brain pages 时先检查 notability

## 容易踩坑的地方

1. **MECE violations 会静默复利。** 两个 skill 都创建 `brain/people/` 会产生重复和冲突。
2. **质量标准是真的。** 没在真实 items 上测试过的 skill 不要上 cron。
3. **不要创建 stubs。** `TODO: implement` 不是 skill。

## 如何验证

1. 在 3 个真实 items 上跑 skill。
2. 对照 ownership table 检查 MECE。
3. 逐项检查 Quality Bar Checklist。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
