---
title: default source mention-link extraction review
type: report
category: quality-link-review
date: 2026-07-17
source_id: default
status: completed
---

# `default` 源提及关系审阅报告

## 范围与结论

- 发现命令：`voltmind extract links --by-mention --source db --dry-run`
- 扫描范围：88 个页面；实体词典：17 个首词桶。
- 结果：可新增 **45** 条 `mentions` 关系。
- 本次为 dry-run，**未写入任何关系**。
- 相关文件路径核对：`voltmind sources reconcile default --dry-run` 报告 42 个路径关联页面中 0 个缺失。
- Embedding：用户已完成此前报告的 25 个 stale chunks；本报告不重复执行 embedding。

## 审阅规则

下表的“建议”是对自动匹配的人工判断，不是系统已写入的关系：

- **通过**：名称看起来是明确的人名，且来源页面的语义适合建立提及关系。
- **复核**：名称或页面语义可能是导航/状态词，或仅凭词面不足以确认实体含义。

## 候选关系

| # | 来源页面 | 目标页面 | 命中名称 | 建议 |
|---:|---|---|---|---|
| 1 | `daily/2026/2026-06-08` | `people/joki-hong` | Joki Hong | 通过 |
| 2 | `daily/2026/2026-06-08` | `people/jiaxing-he` | Jiaxing He | 通过 |
| 3 | `daily/2026/2026-06-08` | `people/charlotte-an` | Charlotte An | 通过 |
| 4 | `daily/2026/2026-06-08` | `people/qian-ye` | Qian Ye | 通过 |
| 5 | `daily/2026/2026-06-08` | `people/zhiqiang-zhou` | Zhiqiang Zhou | 通过 |
| 6 | `daily/2026/2026-06-11` | `people/qian-ye` | Qian Ye | 通过 |
| 7 | `daily/2026/2026-06-11` | `people/joki-hong` | Joki Hong | 通过 |
| 8 | `daily/2026/2026-06-11` | `people/charlotte-an` | Charlotte An | 通过 |
| 9 | `meetings/2026-06-08-3d-department-weekly` | `people/joki-hong` | Joki Hong | 通过 |
| 10 | `meetings/2026-06-08-3d-department-weekly` | `people/jiaxing-he` | Jiaxing He | 通过 |
| 11 | `meetings/2026-06-08-3d-department-weekly` | `people/charlotte-an` | Charlotte An | 通过 |
| 12 | `meetings/2026-06-08-3d-department-weekly` | `people/qian-ye` | Qian Ye | 通过 |
| 13 | `meetings/2026-06-08-3d-department-weekly` | `people/zhiqiang-zhou` | Zhiqiang Zhou | 通过 |
| 14 | `people/joki-hong` | `people/hao-zhang` | Hao Zhang | 通过 |
| 15 | `people/joki-hong` | `people/zhiqiang-zhou` | Zhiqiang Zhou | 通过 |
| 16 | `people/joki-hong` | `people/zi-ye` | Zi Ye | 通过 |
| 17 | `sources/outlook-calendar-week-2026-06-08` | `people/joki-hong` | Joki Hong | 通过 |
| 18 | `sources/outlook-calendar-week-2026-06-08` | `people/jiaxing-he` | Jiaxing He | 通过 |
| 19 | `sources/outlook-calendar-week-2026-06-08` | `people/charlotte-an` | Charlotte An | 通过 |
| 20 | `sources/outlook-calendar-week-2026-06-08` | `people/qian-ye` | Qian Ye | 通过 |
| 21 | `sources/outlook-calendar-week-2026-06-08` | `people/zhiqiang-zhou` | Zhiqiang Zhou | 通过 |
| 22 | `state/actions/attend-information-security-it-training-2026-06-24` | `people/bo-qin` | Bo Qin | 通过 |
| 23 | `people/zhiqiang-zhou` | `people/joki-hong` | Joki Hong | 通过 |
| 24 | `projects/voltmind-work-brain` | `people/joki-hong` | Joki Hong | 通过 |
| 25 | `state/actions/review-windows-update-policy-check` | `people/bo-qin` | Bo Qin | 通过 |
| 26 | `projects/ai-tooling-runtime` | `people/lida-zheng` | Lida Zheng | 通过 |
| 27 | `state/actions/check-oa-attendance-correction-flow` | `people/yue-wang` | Yue Wang | 通过 |
| 28 | `state/actions/follow-up-jenny-api-key` | `people/charlotte-an` | Charlotte An | 通过 |
| 29 | `inbox/readme` | `people/primary-home` | Primary Home | **复核** |
| 30 | `index` | `people/primary-home` | Primary Home | **复核** |
| 31 | `resolver` | `people/primary-home` | Primary Home | **复核** |
| 32 | `resolver` | `people/open-thread` | Open Thread | **复核** |
| 33 | `state/readme` | `people/primary-home` | Primary Home | **复核** |
| 34 | `state/actions/draft-zi-ye-message` | `people/zi-ye` | Zi Ye | 通过 |
| 35 | `daily/2026/2026-06-15` | `people/joki-hong` | Joki Hong | 通过 |
| 36 | `daily/2026/2026-06-15` | `people/jiaxing-he` | Jiaxing He | 通过 |
| 37 | `daily/2026/2026-06-15` | `people/charlotte-an` | Charlotte An | 通过 |
| 38 | `daily/2026/2026-06-15` | `people/qian-ye` | Qian Ye | 通过 |
| 39 | `daily/2026/2026-06-15` | `people/zhiqiang-zhou` | Zhiqiang Zhou | 通过 |
| 40 | `daily/2026/2026-06-15` | `people/lida-zheng` | Lida Zheng | 通过 |
| 41 | `daily/2026/2026-06-15` | `people/diana-mengdie-zhang` | Diana Mengdie Zhang | 通过 |
| 42 | `daily/2026/2026-06-12` | `people/joki-hong` | Joki Hong | 通过 |
| 43 | `daily/2026/2026-06-12` | `people/hao-zhang` | Hao Zhang | 通过 |
| 44 | `daily/2026/2026-06-12` | `people/zhiqiang-zhou` | Zhiqiang Zhou | 通过 |
| 45 | `daily/2026/2026-06-12` | `people/zi-ye` | Zi Ye | 通过 |

## 需要确认的 5 条

以下候选全部命中“Primary Home”或“Open Thread”。它们更像知识库导航/状态概念，而非人物页面；若 `people/primary-home` 与 `people/open-thread` 确实承载的是人物实体，才建议保留。

1. `inbox/readme` → `people/primary-home`
2. `index` → `people/primary-home`
3. `resolver` → `people/primary-home`
4. `resolver` → `people/open-thread`
5. `state/readme` → `people/primary-home`

## 确认后的执行方式

命令只能全量应用本次扫描结果，不能根据本表排除单条候选：

```powershell
$env:VOLTMIND_ENGINE='postgres'
& 'E:\gbrain\VoltMind\bin\voltmind.exe' extract links --by-mention --source db
```

因此，只有在确认上述 5 条也应写入时，才执行该命令。若需要排除它们，应先修正或归档对应的 `people/primary-home` / `people/open-thread` 实体页，再重新运行 dry-run，确保候选集干净后再应用。

## 用户确认记录

- [x] 不同意写入 5 条复核候选；确认 `people/primary-home` 与 `people/open-thread` 是历史噪声。
- [x] 同意写入其余候选关系。

## 执行结果（2026-07-17）

- 已软删除 `people/primary-home` 与 `people/open-thread`；可在 72 小时内恢复。
- 已确认指定 Markdown 源目录没有这两个 slug 对应的文件，因此后续同步不会将它们重新导入。
- 删除后重新运行按提及抽取：在 86 个页面、15 个首词桶中新增 **29** 条关系。
  原先获批的 40 条候选中，另有 11 条关系已存在，故无需重复创建。
- Embedding 复检为 **100% 覆盖、0 个 stale chunks**。
- 实体链接覆盖从 `78% ± 9.8%` 升至 **`88% ± 8.3%`**，已不属于低覆盖告警。

## 时间线覆盖诊断

复检的时间线覆盖为 **`75% ± 10.8%`**，对应 16 个被计入的实体页中 12 个拥有结构化时间线、4 个为空：

1. `templates/people`：模板页，没有时间线。
2. `templates/companies`：模板页，没有时间线。
3. `people/lirui-zhang`：正文包含 `- 2026-06-02 | ...`，但数据库结构化时间线为空。
4. `people/yiyang-zhang`：正文包含 `- 2026-06-16 | ...`，但数据库结构化时间线为空。

`voltmind extract timeline --source db --dry-run` 扫描 86 页后可新增 0 条，说明不是漏跑批量抽取。两个真实人物页的时间线日期没有加粗；当前抽取约定要求 `- **YYYY-MM-DD** | ...`，因此未被识别为结构化事件。

要稳定达到 90%，不能给模板页伪造时间线。应先将两个模板页改为不参与实体覆盖的模板类型（或在覆盖检查中排除），并将两个人物页的现有时间线重写为可解析格式后再同步/抽取。完成后预期为 14/14 个真实实体页拥有时间线。

## 覆盖率修复结果（2026-07-17）

- `people/lirui-zhang` 的日期行已修正为 `- **2026-06-02** | ...`。
- `people/yiyang-zhang` 的日期行已修正为 `- **2026-06-16** | ...`。
- 重新抽取后新增 2 条结构化时间线，分别对应上述人物页。
- `templates/people` 与 `templates/companies` 已从 `person/company` 改为 `template`；最终复检中，它们不再出现在实体类型列表。
- 实体集合从 16 页变为 14 页，均为真实人物实体。
- 最终 `entity_link_coverage`：**100% ± 0.0%**。
- 最终 `timeline_coverage`：**100% ± 0.0%**。
- 总健康分从本轮修复前的 40 提升至 **60**；其余警告（会话格式、完整性、reranker 鉴权等）不属于本次关系与时间线范围。
