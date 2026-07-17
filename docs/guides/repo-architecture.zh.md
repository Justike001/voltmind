# 双 Repo 架构：Agent 行为 vs 世界知识

## 目标
把 agent behavior（可替换）和 world knowledge（永久）分离到两个 repo，并保持严格边界。

## 用户得到什么
没有它：agent config 和世界知识混在一起，换 agent 会丢知识，换知识工具会丢 agent 设置。有了它：brain 中的人、公司、会议、想法能跨 agent 存活，agent config 也能跨知识工具存活。

## 实现

### Boundary Test

**“这是关于 agent 如何运行，还是关于世界的知识？”**

| Question | If YES -> Agent Repo | If YES -> Brain Repo |
|----------|---------------------|---------------------|
| Would this file transfer if you switched AI agents? | YES | -- |
| Would this file transfer if you switched to a different person? | -- | YES |
| Is this about how the agent behaves? | YES | -- |
| Is this about a person, company, deal, meeting, or idea? | -- | YES |

### Quick Decision Tree

~~~
New file to create?
  |-- About a person, company, deal, project, meeting, idea? -> brain/
  |-- A spec, research doc, or strategic analysis? -> brain/
  |-- An original idea or observation? -> brain/originals/
  |-- A daily session log or heartbeat state? -> agent-repo/
  |-- A skill, config, cron, or ops file? -> agent-repo/
  |-- A task or todo? -> agent-repo/tasks/
~~~

### Agent Repo（operational config）

agent 如何工作：身份、配置、操作状态、skills、cron、tasks、hooks、scripts、memory。

### Brain Repo（world knowledge）

你知道什么：people、companies、deals、meetings、originals、concepts、ideas、media、sources、daily、projects、writing、diligence。

### Hard Rule

**永远不要把知识写到 agent repo。** 关于人物、公司、deal、会议、项目或想法的文件必须进入 brain repo。

### Why Two Repos

独立性、规模、隐私和索引边界都要求分离。VoltMind 只索引 brain repo，不索引 agent repo。

## 容易踩坑的地方

1. **不要把知识写到 agent repo。** 这是最常见违规。
2. **brain 是永久记录。** 能跨不同 AI agent 保留的内容属于 brain。
3. **不要索引 agent repo。** 否则搜索会被 operational config 污染。

## 如何验证

1. 检查新文件位置是否正确。
2. 对最近 5 个文件运行 boundary test。
3. `voltmind stats` 中 indexed paths 不应指向 agent repo。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
