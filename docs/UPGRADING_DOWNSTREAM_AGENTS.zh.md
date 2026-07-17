# 升级下游 Agents

VoltMind 会在 `skills/` 中发布 skills。下游 agents（自定义 OpenClaw deployments、各种 agent forks）经常会把这些 skill files **复制**到自己的 workspace，并随着时间分叉：添加 agent-specific phases、删除无关步骤、收紧语言。一旦这样做，voltmind 就无法把更新推送到那些 forks。agent 必须手动应用 diffs。

本文列出每个 downstream agent 在升级时需要应用的精确 diffs。请与你 fork 中的本地 skill files 交叉核对。

## 为什么存在

`voltmind upgrade` 发布新的 binary。`voltmind post-upgrade [--execute --yes]` 运行 schema migrations 并 backfill 数据。但真正告诉 agent 如何行动的 **skill files themselves** 是用户拥有的。如果你的 `~/git/<your-agent>/workspace/skills/brain-ops/SKILL.md` 顶部写着 `# Based on voltmind v0.10.0`，它就不知道 v0.12.0 的功能。

agent 会在每次 `put_page` 后继续手动调用 `voltmind link`（现在已冗余，因为 auto-link 会处理），错过关系问题上的 `voltmind graph-query`，也不知道要 backfill structured timeline。

## 如何应用

1. 找到 forked skill files，通常在 `~/git/<your-agent>/workspace/skills/` 或你的 agent skill directory。
2. 对下面列出的每个 skill，在 fork 中找到匹配 phase/section。
3. 应用 diff（把新 block 粘贴到指定位置）。
4. 更新 fork 顶部的 version banner（`# Based on voltmind v0.12.0`）。
5. 验证：让 agent 写一个测试页，并确认 response 包含 `auto_links: { created, removed, errors }`。

全部四个 skills 约 10 分钟。

---

## 1. brain-ops/SKILL.md

**Where:** 在 `### Phase 2: On Every Inbound Signal` 后立即插入新的 `### Phase 2.5` section。

**Why:** Phase 2.5 声明 auto-link 会自动运行。没有它，agent 的 mental model 会认为每次 `put_page` 后都必须调用 `voltmind link`，这已冗余，并可能导致 double-add warnings。

```markdown
### Phase 2.5: Structured Graph Updates (automatic)

Every `put_page` call automatically extracts entity references and writes them
to the graph (`links` table) with inferred relationship types. Stale links
(refs no longer in the page text) are removed in the same call. This is
"auto-link" reconciliation.

- No manual `add_link` calls needed for ordinary page writes.
- Inferred link types: `attended` (meeting -> person), `works_at`, `invested_in`,
  `founded`, `advises`, `source` (frontmatter), `mentions` (default).
- The `put_page` MCP response includes `auto_links: { created, removed, errors }`
  so the agent can verify outcomes.
- To disable: `voltmind config set auto_link false`. Default is on.
- Timeline entries with specific dates still need explicit `voltmind timeline-add`
  (or batch via `voltmind extract timeline --source db`).
```

**也更新 Iron Law section。** 如果 fork 中仍有未加限定的 “Back-links maintained on every brain write (Iron Law)”，追加：

```markdown
**v0.12.0 update:** Auto-link satisfies the Iron Law for entity-reference links
on every `put_page`. The agent's Iron Law obligation is now: include the
entity reference in the page content (e.g., `[Alice](people/alice)`); auto-link
handles the structured row. Manual `add_link` calls are reserved for
relationships you can't express in markdown content.
```

---

## 2. meeting-ingestion/SKILL.md

**Where:** 追加到 `### Phase 3: Attendee enrichment` 末尾。

**Why:** 避免每个 attendee 都重复调用 `voltmind link`（meeting page 中以 `[Name](people/slug)` 引用 attendees 时，auto-link 会处理）。

```markdown
**Note (v0.12.0):** Once the meeting page is written via `voltmind put`, the
auto-link post-hook automatically creates `attended` links from the meeting
to each attendee whose page is referenced as `[Name](people/slug)`. You don't
need to call `voltmind link` for attendees. You DO still need `voltmind timeline-add`
for dated events (auto-link only handles links, not timeline entries).
```

**Where:** 在 `### Phase 4: Entity propagation` 中，把 “Back-link from entity page to meeting page” 替换为：

```markdown
4. Entity references in the meeting page body auto-create the link via auto-link.
   For incoming references on the entity page (entity page → meeting page), edit
   the entity page to mention the meeting and `put_page` it — auto-link handles
   the rest.
```

---

## 3. signal-detector/SKILL.md

**Where:** 追加到 `### Phase 2: Entity Detection` 末尾。

**Why:** 与 brain-ops 逻辑相同，避免在写入引用 people 或 companies 的 originals/ideas pages 后手动 `voltmind link`。

```markdown
**Auto-link (v0.12.0):** When you write/update an originals or ideas page that
references a person or company, the auto-link post-hook on `put_page`
automatically creates the link from the new page to that entity. You don't
need to call `voltmind link` manually. Timeline entries still need explicit calls.
```

---

## 4. enrich/SKILL.md

**Where:** 用 v0.12.0 版本替换 `### Step 7: Cross-reference`。

**Why:** Step 7 过去主要是创建相关 entity pages 之间的 links。现在 auto-link 会自动完成。Step 7 改为关注内容更新，而不是 link creation。

Old（delete）：
```markdown
### Step 7: Cross-reference

- Update company pages from person enrichment (and vice versa)
- Update related project/deal pages if relevant context surfaced
- Check index files if the brain uses them
- Add back-links manually via `voltmind link` for any new entity references
```

New（paste）：
```markdown
### Step 7: Cross-reference

- Update company pages from person enrichment (and vice versa)
- Update related project/deal pages if relevant context surfaced
- Check index files if the brain uses them

**Note (v0.12.0):** Links between brain pages are auto-created on every
`put_page` call (auto-link post-hook). Step 7 focuses on content
cross-references (updating related pages' compiled truth with new signal
from this enrichment), not on creating links. Verify via the `auto_links`
field in the put_page response (`{ created, removed, errors }`).
Timeline entries still need explicit `voltmind timeline-add` calls.
```

---

## 应用完四个 diffs 后

1. **Bump version banner**，更新每个 forked file 顶部：
   ```
   # Based on voltmind v0.12.0 skills/<skill-name>, extended with <your-agent>-specific config
   ```

2. **运行 v0.12.0 backfill**（为现有 brain 填充 graph）：
   ```bash
   voltmind post-upgrade
   ```
   v0.12.0 release 会让 post-upgrade 自动调用 `apply-migrations --yes`，运行 v0_12_0 orchestrator（schema → config check → `extract links --source db` → `extract timeline --source db` → verify）。幂等；没有 pending 时很便宜。

3. **验证 auto-link 工作**：让 agent 写一个引用 `[Some Person](people/some-person)` 的 test page。确认 put_page response 包含 `auto_links: { created: 1, removed: 0, errors: 0 }`。

4. **验证 graph traversal 工作：**
   ```bash
   voltmind graph-query people/some-well-connected-person --depth 2
   ```
   应返回 typed edges 的缩进树。

---

## v0.12.2 hotfix（data-correctness，无 skill edits）

v0.12.2 是 Postgres data-correctness hotfix。不需要改 forked skill files，skill contracts 不变。但你需要运行 migration，并了解 markdown parsing 的一个行为变化。

### 1. 运行 migration（Postgres-backed brains）

```bash
voltmind upgrade
```

`v0_12_2` orchestrator 会自动运行 `voltmind repair-jsonb`，修复 `pages.frontmatter`、`raw_data.data`、`ingest_log.pages_updated`、`files.metadata`、`page_versions.frontmatter` 中 `jsonb_typeof = 'string'` 的 rows。幂等且可重跑。PGLite brains 会 clean no-op。

验证：

```bash
voltmind repair-jsonb --dry-run --json    # expect totalRepaired: 0
```

### 2. 恢复被截断的 wiki articles

如果 brain 在 v0.12.2 前导入过 wiki-style markdown，部分 pages 可能被静默截断（body content 中任何独立 `---` 都会被视为 timeline separator）。从源重新导入：

```bash
voltmind sync --full
```

新的 `splitBody` 会正确重建 `compiled_truth`。

### 3. 了解未来 splitBody contract

`splitBody` 现在要求显式 timeline sentinel。识别 markers（按优先级）：

1. `<!-- timeline -->`（preferred，`serializeMarkdown` 会发出）
2. `--- timeline ---`（decorated separator）
3. `---` 直接位于 `## Timeline` 或 `## History` heading 前（backward-compat）

body text 中裸 `---` 现在是 markdown horizontal rule，不是 timeline separator。如果你的 agent 用裸 `---` delimiter 写 pages，请迁移到 `<!-- timeline -->`；`serializeMarkdown` helper 已经这样做。

### 4. Wiki subtypes now auto-typed

`inferType` 现在会把五种额外 directory patterns 自动识别为自己的 page types（过去都 default 到 `concept`）：

| Path pattern           | New type       |
|------------------------|----------------|
| `/wiki/analysis/`      | `analysis`     |
| `/wiki/guides/`        | `guide`        |
| `/wiki/hardware/`      | `hardware`     |
| `/wiki/architecture/`  | `architecture` |
| `/writing/`            | `writing`      |

如果你的 skills 或 queries 按 `type=concept` 过滤并期望 wiki content 在该 bucket 中，请更新为包含这些新 types。

---

## v0.13.0 — Frontmatter Relationship Indexing

**Verdict：大多数 skills 无需行动。** v0.13 会把 YAML frontmatter fields 投射为 graph typed edges。ingestion API 不变：继续像今天一样用 frontmatter 调用 `put_page`；graph 会在幕后自动填充。

如果你想消费新的 `auto_links.unresolved` response field，有三个 skills 可以添加 optional phase。没有它时，无法解析的 frontmatter names 会静默跳过（与 v0.12 behavior 相同）。

### 1. meeting-ingestion/SKILL.md（optional）

**Where:** 在 “Phase 3: Write Meeting Page” 后添加新 section。

```markdown
### Phase 3.5: Check for unresolved attendees (v0.13+)

After `put_page`, inspect `response.auto_links.unresolved` — an array of frontmatter
references that did not resolve to existing pages. For meetings, this usually means
attendees you haven't created a person page for yet.

If `unresolved.length > 0`:
- Option 1 (create pages now): trigger an enrichment pass to build the missing people pages.
- Option 2 (defer): log the unresolved names to the enrichment queue for later.
- Option 3 (accept the gap): the attendee edge will not be created until a page exists.
  Re-running `voltmind extract links --source db --include-frontmatter` after creating
  the page fills in the missing edges.
```

### 2. enrich/SKILL.md（optional）

**Where:** 添加到 enrichment trigger list。

```markdown
### Drain unresolved frontmatter names (v0.13+)

If any `put_page` response includes `auto_links.unresolved` entries, the enrichment
tier should pick up those (field, name) pairs and try to create the missing entity
pages. Example flow:

1. signal-detector captures a meeting with `attendees: [Alice Known, Unknown Person]`
2. put_page returns `auto_links.unresolved = [{field: 'attendees', name: 'Unknown Person'}]`
3. enrichment tier consumes `Unknown Person` → web search → creates `people/unknown-person.md`
4. The next put_page (or a backfill run) wires up the `attended` edge automatically
```

### 3. idea-ingest/SKILL.md（optional）

**Where:** 与 meeting-ingestion 相同：`put_page` 后检查 `auto_links.unresolved`，把 names 路由给 enrichment。

### Unchanged skills（no diffs needed）

- **brain-ops/SKILL.md** — auto-link mechanics 内部处理；write path 不变。
- **signal-detector/SKILL.md** — signal capture path 不变。
- **query/SKILL.md** — `traverse_graph` 现在自动返回更丰富结果。
- **daily-task-manager/SKILL.md**, **briefing/SKILL.md**, **citation-fixer/SKILL.md**, **media-ingest/SKILL.md** — unchanged。

### New edge types you can filter in graph queries

v0.13 edges 携带新的 `link_type` 值。若 fork 中有按 type 过滤的 graph-query skills，可使用这些类型：

- `works_at`（person → company）— 来自 `company:`, `companies:`, 或 `key_people:`
- `founded`（person → company）— 来自 `founded:`
- `invested_in`（investor → deal/company）— 来自 `investors:` 或 `lead:`
- `led_round`（lead → deal）— 来自 `lead:`
- `yc_partner`（partner → company）— 来自 `partner:`
- `attended`（person → meeting）— 来自 `attendees:`
- `discussed_in`（source → page）— 来自 `sources:`
- `source`（page → source）— 来自 `source:`
- `related_to`（page → target）— 来自 `related:` 或 `see_also:`

### Migration timing

`voltmind upgrade` 在 46K-page brain 上需要 2-5 分钟（一次性）。通过 `voltmind post-upgrade` out-of-process 运行。如果 agent 在升级期间持有 DB connection，升级后重新连接；否则继续服务即可。

### Type normalization NOT in v0.13

旧行中 `link_type='attendee'` 或 `link_type='mention'` 会与新的 `'attended'` / `'mentions'` rows 共存。按旧 type names 过滤的 queries 仍可工作。v0.14 中单独的 opt-in `voltmind normalize-types` 命令处理重命名。

## v0.14.0 shell jobs（optional adoption，无 skill edits）

新增 Minions 的 `shell` job type，让 deterministic cron scripts（API fetch、token refresh、scrape + write）移出 LLM gateway。每次触发零 tokens，典型规模下约 60% gateway CPU headroom。功能**默认关闭**，现有 installs 完全照旧。

采用时按 `skills/migrations/v0.14.0.md`。短版：

1. 在 worker process 上设置 `VOLTMIND_ALLOW_SHELL_JOBS=1`，然后运行 `voltmind jobs work`（Postgres）。PGLite 上每个 crontab invocation 用 `--follow` inline execution，不需要 persistent worker。
2. 对每个 host cron entry 分类：需要 LLM 的留在 gateway，deterministic 的迁到 shell。
3. 对每个 deterministic cron，改写为：
   ```cron
   3 13,16,19,22,1,4,7,10 * * * \
     voltmind jobs submit shell \
       --params '{"cmd":"node scripts/your-script.mjs","cwd":"/data/.openclaw/workspace"}' \
       --max-attempts 3 --timeout-ms 300000
   ```
4. 每次触发后查看 `voltmind jobs get <id>` 的 exit_code / stdout_tail / stderr_tail。与迁移前行为对比，再批准下一批。

**不需要 skill edits。** handler 在 worker-side 运行；skill files 不变。若 host 通过 plugin contract（v0.11.0）暴露 custom handlers，它们照常工作。

铁律：**绝不自动重写 operator 的 crontab。** 每次 rewrite 都是 per-cron、human-approved，并带 diff。未来自动化可使用即将到来的 `voltmind crontab-to-minions <file>` helper（TODOS 中 P1）。

---

## v0.16.0：durable agent runtime

v0.15 发布 `voltmind agent run` / `voltmind agent logs`、Minions 中新的 `subagent` handler type，以及 host-repo subagent defs 的 plugin contract。现有 skills 都不需要手术。下游 agents 的问题是如何采用新 runtime，而不是如何绕过 breaking change。

要点：

1. **运行带 Anthropic key 的 worker。**
   ```bash
   ANTHROPIC_API_KEY=sk-ant-... voltmind jobs work
   ```
   startup 会打印 `[minion worker] subagent handlers enabled`。

2. **把 subagents 作为 plugin 发布。**
   ```
   ~/<your-agent>/voltmind-plugin/
   ├── voltmind.plugin.json
   └── subagents/
       ├── meeting-ingestion.md
       ├── signal-detector.md
       └── daily-task-prep.md
   ```

3. **用 durable runs 替换 ephemeral subagent runs。**
   ```bash
   voltmind agent run "analyze my last 50 journal pages for recurring themes" \
     --subagent-def analyzer --fanout-manifest manifests/journal-pages.json
   ```

4. **subagent 内的 `put_page` 写入 agent namespace。** 来自 subagent tool dispatch 的 writes 必须指向 `wiki/agents/<subagent_id>/...`。这不影响 skill files、CLI put_page 或 MCP put_page。

铁律：**绝不授予 agent 超出其 namespace 的写权限。**

---

## v0.22.4 — frontmatter-guard adoption

### 1. 停止手写 frontmatter validators

如果 fork 中有直接调用 `js-yaml` 验证 brain page frontmatter 的 scripts，请改用 `voltmind frontmatter validate`。CLI 覆盖七类 canonical errors，并提供跨版本稳定的 `--json` envelope。

```diff
- # Custom validator script
- node scripts/validate-frontmatter.mjs <path>
+ voltmind frontmatter validate <path> --json
```

需要在脚本中使用 validator 的 consumers，请从 voltmind 的 `markdown` export import，而不是复制逻辑：

```ts
import { parseMarkdown } from 'voltmind/markdown';

const parsed = parseMarkdown(content, filePath, { validate: true, expectedSlug });
for (const err of parsed.errors ?? []) {
  // err.code: MISSING_OPEN | MISSING_CLOSE | YAML_PARSE | SLUG_MISMATCH |
  //           NULL_BYTES | NESTED_QUOTES | EMPTY_FRONTMATTER
}
```

### 2. 删除对 `lib/brain-writer.mjs` 的引用

如果 fork 的 skills 或 scripts 引用了设想中的 `lib/brain-writer.mjs`（它从未发布，spec 在 PR #392 且未落地），请替换为 voltmind CLI。`frontmatter-guard` skill 位于 `skills/frontmatter-guard/SKILL.md`，并指向 `voltmind frontmatter validate` / `audit` / `install-hook`。

### 3. 把 doctor subcheck 接入 health pipeline

`voltmind doctor` 现在自动报告 `frontmatter_integrity`。如果 fork 有自定义 health pipeline（例如每日 Slack brain health 报告），请从 `voltmind doctor --json` 读取并展示 `frontmatter_integrity` row counts。

### 4.（Optional）在 brain repos 安装 pre-commit hook

对 git-backed sources，v0.22.4 install-hook helper 会放置 pre-commit script，阻止 malformed frontmatter commits：

```bash
voltmind frontmatter install-hook
```

如果 brain 不是 git repo，或 downstream agent 已在 write time 强制 validation，可跳过。完整 recipe 见 `docs/integrations/pre-commit.md`。

### 5. Migration ergonomics — 读取 pending-host-work.jsonl

`voltmind apply-migrations --yes` 运行 v0.22.4 audit 后，agent 应读取 `~/.voltmind/migrations/pending-host-work.jsonl`（过滤 `migration === "0.22.4"`），逐条处理 `command` field。每条都指向 per-source `voltmind frontmatter validate <source_path> --fix` 命令。向用户展示 counts，获得明确同意后再运行。

migration 是 **audit-only**。`apply-migrations` 期间绝不修改 brain content。agent 在用户同意后运行 fix command。

---

## Future versions

voltmind 发布新版本时，本文会追加该版本需要的 diffs。每个新版本追加 section；旧 sections 保留，方便一次追多个版本。

检查 fork 缺少什么：

```bash
diff <(grep -A3 "Based on voltmind" ~/<your-fork>/skills/brain-ops/SKILL.md) \
     <(grep "v[0-9]" ~/voltmind/skills/migrations/ | tail -3)
```
