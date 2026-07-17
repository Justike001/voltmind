# VoltMind 安装验证 Runbook

安装后运行这些检查，确认 VoltMind 的每个部分都能工作。每个检查都包含命令、期望输出，以及失败时的处理方式。

最重要的检查是 #4（live sync）。“Sync 跑过了”和“sync 真的工作了”不是一回事。因为 pooler bug 而静默跳过 pages 的 sync 比完全没有 sync 更糟，因为你会以为它在工作。

---

## 1. Schema Verification

**Command:**

```bash
voltmind doctor --json
```

**Expected:** 所有 checks 返回 `"ok"`：
- `connection`: connected, N pages
- `pgvector`: extension installed
- `rls`: enabled on all tables
- `schema_version`: current
- `embeddings`: coverage percentage

**If it fails:** doctor 输出会为每个 check 包含具体修复说明。见 `skills/setup/SKILL.md` Error Recovery table。

---

## 2. Skillpack Loaded

**Check:** 问 agent：“What is the brain-agent loop?”

**Expected:** agent 引用 VOLTMIND_SKILLPACK.md Section 2，并描述 read-write cycle：detect entities、read brain、respond with context、write brain、sync。

**If it fails:** agent 尚未加载 skillpack。运行 install paste 的 step 6（读取 `docs/VOLTMIND_SKILLPACK.md`）。

---

## 3. Auto-Update Configured

**Command:**

```bash
voltmind check-update --json
```

**Expected:** 返回包含 `current_version`, `latest_version`, `update_available`（boolean）的 JSON。cron `voltmind-update-check` 已注册。

**If it fails:** 运行 install paste 的 step 7。见 VOLTMIND_SKILLPACK.md Section 17。

---

## 4. Live Sync Actually Works

这是最重要的检查，分三部分。

### 4a. Coverage Check

比较 DB 中的 page count 与 repo 中 syncable file count：

```bash
voltmind stats
```

然后统计可 sync 文件：

```bash
find /data/brain -name '*.md' \
  -not -path '*/.*' \
  -not -path '*/.raw/*' \
  -not -path '*/ops/*' \
  -not -name 'README.md' \
  -not -name 'index.md' \
  -not -name 'schema.md' \
  -not -name 'log.md' \
  | wc -l
```

**Expected:** `voltmind stats` 中的 page count 应接近文件数量。存在一些差异正常（上次 sync 后新增文件），但如果 page count 少于 file count 的一半，sync 正在静默跳过 pages。

**If page count is way too low:** #1 原因是 connection pooler bug。检查 `DATABASE_URL`：
- 如果包含 `pooler.supabase.com:6543`，确认它使用 **Session mode**，不是 Transaction mode。
- Transaction mode 会破坏 `engine.transaction()`，导致 `.begin() is not a function` 错误。
- 修复：切换到 Session mode pooler string，然后运行 `voltmind sync --full` 重新导入全部内容。

### 4b. Embed Check

```bash
voltmind stats
```

**Expected:** Embedded chunk count 应接近 total chunk count。

**If embedded is much lower than total:**

```bash
voltmind embed --stale
```

如果未设置 `OPENAI_API_KEY`，无法生成 embeddings。Keyword search 仍可用，但 hybrid/semantic search 不可用。

### 4c. End-to-End Test

这是实际测试。编辑 brain page、push、等待、搜索。

1. 编辑 brain repo 中的一个页面（例如修正某个人页面上的事实）：

```bash
# Example: fix a line in Gustaf's page
cd /data/brain
# Make a small edit to any .md file
git add -A && git commit -m "test: verify live sync" && git push
```

2. 等待下一个 sync cycle（cron interval 或 `--watch` poll）。

3. 搜索修正后的文本：

```bash
voltmind search "<text from the correction>"
```

**Expected:** 搜索返回**修正后的**文本，而不是旧版本。

**If it returns old text:** Sync 静默失败。检查：
- sync cron 是否已注册并运行？
- 如果使用 watch mode，`voltmind sync --watch` 是否仍存活？
- 运行 `voltmind config get sync.last_run` 查看上次 sync 时间。
- 手动运行 `voltmind sync --repo /data/brain` 并检查错误。
- 如果看到 `.begin() is not a function`，修复 pooler（见上方 4a）。

---

## 5. Embedding Coverage

**Command:**

```bash
voltmind stats
```

**Expected:** Embedded chunk count 与 total chunk count 匹配或接近。

**If zero or very low:** `OPENAI_API_KEY` 可能缺失或无效。检查：

```bash
echo $OPENAI_API_KEY | head -c 10
```

如果为空，设置 key。然后：

```bash
voltmind embed --stale
```

---

## 6. Brain-First Lookup Protocol

**Check:** 向 agent 询问 brain 中存在的人或概念。

**Expected:** agent 首先使用 `voltmind search` 或 `voltmind query`，而不是 grep 或外部 API。回答包含来自 brain 的上下文和 source attribution。

**If it fails:** brain-first lookup protocol 未注入 agent 的 system context。见 `skills/setup/SKILL.md` Phase D。

---

## 7. Knowledge Graph Wired

v0.12.0 graph layer 需要为现有 brains 填充。新写入会 auto-linked，但历史 pages 需要一次性 backfill。

**Command:**

```bash
voltmind stats | grep -E 'links|timeline'
```

**Expected:** `links` 和 `timeline_entries` 都非零（假设 brain 中有实体引用和 dated markdown）。

**If it's zero on a brain with imported content:** 运行 backfill。

```bash
voltmind extract links --source db --dry-run | head -5    # preview
voltmind extract links --source db                         # commit
voltmind extract timeline --source db
voltmind stats                                             # confirm > 0
```

**Bonus check** — graph traversal 可用：

```bash
# Pick any well-connected slug from your brain
voltmind graph-query people/<some-person-slug> --depth 2
```

**Expected:** typed edges 的缩进树（`--attended-->`, `--works_at-->` 等）。如果该 slug 无 inbound 或 outbound links，换一个或再次运行 extract。

**If extract finds nothing:** 你的 pages 可能没有使用 entity-reference syntax。extractor 匹配 `[Name](people/slug)`, `[Name](../people/slug.md)` 和裸 `people/slug` references。如果 brain 使用其他格式，auto-link heuristics 找不到它们，请带 sample page 提 issue。

---

## 8. JSONB Frontmatter Integrity（v0.12.2）

v0.12.2 之前创建的 Postgres-backed brains 可能有 double-encoded JSONB columns（`frontmatter->>'key'` 返回 NULL，GIN indexes 失效）。`voltmind upgrade` 会通过 `v0_12_2` orchestrator 自动运行 `voltmind repair-jsonb`。请验证修复成功。

**Command:**

```bash
voltmind repair-jsonb --dry-run --json
```

**Expected:** 所有 5 列（`pages.frontmatter`, `raw_data.data`, `ingest_log.pages_updated`, `files.metadata`, `page_versions.frontmatter`）的 `totalRepaired: 0`。0 表示每行都是 proper typed JSON objects，而不是 string-encoded JSON。

**If the count is > 0:** repair 未运行或被中断。不带 `--dry-run` 重跑：

```bash
voltmind repair-jsonb
```

幂等。PGLite brains 始终报告 0（不受原始 bug 影响）。

**Bonus check** — frontmatter-keyed queries 能解析：

```bash
voltmind call list_pages '{"frontmatterKey": "type", "frontmatterValue": "person"}'
```

如果在有 person pages 的 brain 上返回 rows，JSONB path 健康。

---

## Quick Verification（一次跑完全部 checks）

```bash
# 1. Schema
voltmind doctor --json

# 2. Sync recency
voltmind config get sync.last_run

# 3. Page count + embed coverage
voltmind stats

# 4. Search works
voltmind search "test query from your brain content"

# 5. Catch any unembedded chunks
voltmind embed --stale

# 6. Auto-update
voltmind check-update --json

# 7. Knowledge graph populated (links + timeline > 0)
voltmind stats | grep -E 'links|timeline'

# 8. JSONB integrity (v0.12.2 — Postgres only, PGLite always 0)
voltmind repair-jsonb --dry-run --json
```

如果八项都成功返回，安装就是健康的。完整端到端 sync 测试（4c）需要 push 一个真实改动，并验证它出现在 search 中。
