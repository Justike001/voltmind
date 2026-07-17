# Reliability repair (v0.12.2)

如果你在真实 Postgres 或 Supabase 上运行过 v0.12.0，两个 bug 可能已经损坏了
brain 中的数据。v0.12.1 修复了之后的代码路径。v0.12.2 在 `voltmind doctor`
中加入检测，并为可机械修复的类别加入独立的 `voltmind repair-jsonb` 命令。
PGLite 用户不受影响。

## What got corrupted

**JSONB double-encode。** 四个写入点使用 postgres.js 的
`${JSON.stringify(x)}::jsonb`，结果存入的是 JSONB *string literal*，
而不是 object。`frontmatter ->> 'key'` 返回 NULL；GIN 索引失效。受影响：
`pages.frontmatter`、`raw_data.data`、`ingest_log.pages_updated`、
`files.metadata`。

**Markdown body truncation。** `splitBody()` 把 `---` horizontal rules
当成 body/timeline delimiter，丢弃第一条 rule 后的所有内容。
带多个 `##`/`###` sections 的 wiki-style pages 在 import 时丢失了大部分内容。

## Detect

```
voltmind doctor
```

报告两个新检查：

- `jsonb_integrity` — 统计每张表中 double-encoded rows，并指向
  `voltmind repair-jsonb`。
- `markdown_body_completeness` — heuristic，用于找出 `compiled_truth`
  相比 `raw_data.data ->> 'content'` 可疑地短的 pages。

## Repair

对于 JSONB（可机械修复）：

```
voltmind repair-jsonb
```

在每个受影响列上运行 `UPDATE <table> SET <col> = (<col>#>>'{}')::jsonb WHERE jsonb_typeof(<col>) = 'string'`。
幂等。第二次运行报告 0 rows。使用 `--dry-run` 预览，`--json` 获取结构化输出。
`v0_12_2` migration 会在 `voltmind upgrade` 时自动运行它。

对于被截断的 markdown bodies（取决于 source）：

```
voltmind sync --force
# or per-page
voltmind import <slug> --force
```

如果你已经没有 source markdown file，v0.12.2 无法恢复已经丢失的内容。
`voltmind doctor` 会告诉你哪些 pages 看起来过短；由你决定从 source 重新导入，
还是接受截断。

## Verify

```
voltmind doctor
```

全部四个 `jsonb_integrity` rows 都应为 zero。`markdown_body_completeness`
应符合你对语料库的预期。
