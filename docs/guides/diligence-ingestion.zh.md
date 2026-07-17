# Diligence 摄取：从 Data Room 到 Brain 页面

## 目标

把 pitch deck、financial model 和 data room 材料变成可搜索、可交叉引用，并带有 bull/bear 分析的 brain 页面。

## 用户得到什么

没有它：deck 躺在邮件附件里，模型在 Google Drive，和公司 brain 页面没有关联，也搜不到关键指标。

有了它：每份 data room 文档都会被抽取、diarize、关联到公司页并可搜索。`index.md` 一眼呈现 bull/bear case。

## 实现

通过文件名和内容识别材料：Data Deck、Intro Deck、Data Room、Cap Table、Financial Model、Investor Memo、Pitch Deck、轮次名；表格里的 Revenue、Retention、Cohorts、CAC、Gross Margin、Unit Economics、ARR；以及用户说的 “data room”、“diligence”、“deck”、“pitch”。

### 9 步 Pipeline

**Step 1: Identify the Company.** 从文档内容或文件名识别公司名，并检查 `brain/companies/{slug}.md`。

**Step 2: Create Diligence Directory.**

~~~bash
mkdir -p brain/diligence/{company-slug}/.raw
~~~

**Step 3: Extract Content.** PDF 用抽取工具，扫描件或图片型 PDF 用 OCR；表格每个 sheet 导出 CSV。

~~~
https://docs.google.com/spreadsheets/d/{ID}/gviz/tq?tqx=out:csv&sheet={Sheet Name}
~~~

**Step 4: Diarize and Save.** 写入 `brain/diligence/{company}/{doc-name}.md`，包含标题、类型、分节拆解、关键指标、脚注和相关原始表格。

**Step 5: Save Raw Files.** 原始 PDF/文件复制到 `.raw/`，原件用于审计，diarized 版本用于搜索。

**Step 6: Create or Update index.md.** 每个 diligence 目录都需要 `index.md`，包含轮次、文档清单、关键发现、Bull Case、Bear Case 和 Open Questions。

~~~markdown
# {Company Name} — Diligence

## Round Details
- Stage: Series A
- Amount: $10M
- Date: 2026-04

## Document Inventory
- [Pitch Deck](pitch-deck.md) — 25 slides, company overview + traction

## Key Findings
- Revenue growing 30% MoM for last 6 months

## Bull Case
- Strong product-market fit signal (NPS 72)

## Bear Case
- Single customer represents 40% of revenue

## Open Questions
- What's the path to profitability?
~~~

**Step 7: Enrich Company Brain Page.** 更新 `brain/companies/{slug}.md`：frontmatter 来源、compiled truth、See Also 链接；没有公司页则通过 enrich skill 创建。

**Step 8: Commit.**

~~~bash
cd brain/ && git add -A && git commit -m "diligence: {Company} — {doc type} ingestion" && git push
~~~

**Step 9: Publish (if asked).** 如果用户需要可分享 brief，创建密码保护版本，并移除内部备注和原始评估语言。

### 质量标准

好的 diligence 页面像情报评估：区分“他们怎么说”和“数据怎么显示”，明确 bull/bear case，突出关键指标，列出决策前必须回答的问题。

## 容易踩坑的地方

1. **PDF 抽取有损。** 扫描件和图片型 deck 会丢表格图表，必须对照 `.raw/` 检查。
2. **重新摄取要幂等。** 同公司新 deck 不要建重复目录；原地更新，必要时给旧版本加 suffix。
3. **index.md 必须完整。** 缺 bull/bear 或 open questions 就不算完成；不确定评估要明确标注。

## 如何验证

1. 摄取后运行 `voltmind search "revenue growth"` 或 `voltmind search "{company name} CAC"`。
2. 打开 `brain/companies/{slug}.md`，确认链接到 diligence 目录且 compiled truth 包含关键发现。
3. 检查 `brain/diligence/{company}/index.md` 是否包含全部 section。

---

*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
