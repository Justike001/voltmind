# System of record

**GitHub repo（markdown + frontmatter）是 system of record。
Postgres/PGLite 数据库是派生缓存。我们不备份数据库 — 我们从 repo 重建它。**

本文档是该契约的规范参考。任何写入用户知识状态的代码路径，都应匹配这里描述的模式。
`scripts/check-system-of-record.sh` 中的 CI gate 会以程序方式强制执行。

## Why this matters

DB 是 markdown 内容上的派生索引。它存在是为了让搜索更快、对 embedding 相似的
claims 去重、物化跨页面 graph。这些数据都不是不可替代的 — 只要 markdown 完好，
`voltmind sync && voltmind extract all` 就能从零重建整个 DB。

这意味着：

- **Disaster recovery is one command.** 如果你的 DB volume 损坏，如果
  Postgres 自毁，如果 PGLite 的 WASM lock 卡死 — 你不需要备份。清空 DB，
  从 brain repo 重新导入，派生状态就会重新生成。v0.32.3 提供了
  `voltmind rebuild --confirm-destructive` 作为文档化的一行命令。
- **Multi-machine sync is git.** 你的 brain 是一个 repo。从一台机器 push，
  从另一台机器 pull，第二台机器的 DB 会在下一次 sync 时重建。没有“备份数据库”步骤。
- **Privacy is in your hands.** 敏感 entity pages 可以被 gitignore
  （通过 `voltmind.yml` 的 `db_only` paths 或逐页设置），它们留在磁盘上但不进 git。
  fence 会尊重你在 page level 做出的任何 git tracking 选择。
- **Cross-agent collaboration is possible.** 多个 agents 可以写同一个 brain，
  因为 fence 是 merge point，而不是 DB。Git 会像处理并发编辑那样处理并发编辑。

## The three categories

voltmind schema 中的每张表都只属于以下三类之一。类别决定了 disaster recovery
期间如何重建。

### FS-canonical（markdown 是事实来源）

这些是用户编写的知识。DB row 是 markdown 上的派生索引 — 清空表后，
`voltmind extract` 会等价地重建它。CI gate 防止直接 DB 写入偏离 markdown contract。

| Category | How it's stored in markdown | Derived DB table | Reconciler |
|---|---|---|---|
| **Takes**（含 hunches、bets） | `## Takes` fenced table between `<!--- voltmind:takes:begin -->` / `:end -->` markers | `takes` | `extract takes` |
| **Facts** | `## Facts` fenced table between `<!--- voltmind:facts:begin -->` / `:end -->` markers | `facts` | `extract_facts` cycle phase |
| **Links** | Inline `[text](slug)` / `[[slug]]` in markdown body + frontmatter `direction: incoming` | `links` | `extract links` |
| **Timeline** | `## Timeline` section after `<!-- timeline -->` sentinel | `timeline_entries` | `extract timeline` |
| **Tags** | Frontmatter `tags:` YAML array | `tags` | `importFromFile`（import 时按页 reconcile） |
| **emotional_weight** | 从 takes + tags 重新计算 | `pages.emotional_weight`（signal column） | `recompute_emotional_weight` cycle phase |
| **synthesis_evidence** | synthesis pages 中指向 `takes` rows（`slug#N`）的 FK | `synthesis_evidence` | `extract takes`（传递地） |

### Derived from FS but not user-authored

这些保存的是从 markdown 自动重建出来的派生状态，但不是用户直接以 markdown
形式编写的。chunker + embedder 会在 import 时重建它们。

| Table | Source | Notes |
|---|---|---|
| `pages` | 整个 markdown file | 每个文件一行；`compiled_truth` + `frontmatter` 来自 parse |
| `content_chunks` | chunker strip 后的 `pages.compiled_truth` | content_hash 变化时重新 chunk；通过配置模型嵌入 |
| `page_versions` | 每次 `pages` UPDATE | 审计历史；原则上可重建，但实践中不会 |

### DB-only by design（命名例外）

这些保存 runtime / infrastructure state，刻意不放进 repo。架构规则仍然成立 —
它们不是 “user knowledge” — 但它们按设计就是 DB-only。

| Category | Why it's OK to be DB-only |
|---|---|
| `raw_data` | Webhook/transcript sidecars；不是用户编写的知识。 |
| `subagent_messages` / `subagent_tool_executions` / `subagent_rate_leases` | Runtime job state。只用于 replay，不是持久知识。 |
| `oauth_clients` / `oauth_tokens` / `access_tokens` | Credentials。按定义不进 source control。 |
| `mcp_request_log` | Audit trail。按设计易变。 |
| `minion_jobs` / `minion_inbox` / `minion_attachments` | Job queue。重启会重新入队或丢弃。 |
| `eval_candidates` / `eval_capture_failures` | Contributor-mode dev loop；opt-in capture。 |
| `dream_verdicts` | 便宜的 verdict cache。可通过重新运行 Haiku 重建。 |
| `voltmind_cycle_locks` / migration ledger | Infrastructure。 |
| `config`（部分 keys） | Site-local routing config（例如 `sync.repo_path`）。 |

任何保存用户知识的新派生表都 MUST 以 FS-first 落地。如果你想“暂时 DB-only”，
结构性问题是：它是否属于这个 DB-only-by-design list？如果不是，它就是
FS-canonical，需要 fence（或 frontmatter field）加 reconciler。

## The privacy boundary

fence 中的私有知识仍然存在于 markdown file 里。如果用户把页面提交到 git，
私有数据也会进入 git。这是现有操作模型 — 我们不推断 git policy。

对于不可信读者（remote MCP、subagent），v0.32.2 release 提供三层 strip：

1. **Layer A (chunker):** `src/core/chunkers/recursive.ts` 在 chunking 前调用
   `stripFactsFence({keepVisibility: ['world']})` + `stripTakesFence`。
   私有 fact text 永远不会进入 `content_chunks.chunk_text`、embeddings 或搜索结果。
2. **Layer B (get_page):** 当 `ctx.remote === true` 时，response body 会 strip
   两个 fences（facts 中的 private rows；整个 takes fence）。Local CLI
   （`ctx.remote === false`）能看到完整 fence。
3. **Layer C (git tracking):** 用户决定是否提交 entity page。`voltmind.yml`
   的 `db_only` paths 会自动 gitignore；逐页选择走用户普通 git workflow。

对于 universally-private entities（朋友姓名、投资人的内部 notes），在
`voltmind.yml` 中把该 entity page 的目录标为 `db_only`。文件留在磁盘上，
但永远不会进入 git。

## The forget contract

`voltmind forget <id>` 和 MCP `forget_fact` op 会把 fence row 改写为
strikethrough + `valid_until = today` + `context: "forgotten:
<reason>"`。DB 的 `expired_at = valid_until + now()` 派生会在每次 rebuild
时重建 forget state，因为 fence 是 canonical。

Strikethrough 有两种语义，由 context 区分：

- `~~claim~~` + `context: "superseded by #N"` → row 被同一 fence 中更新的 row 替换
- `~~claim~~` + `context: "forgotten: <reason>"` → row 通过 forget op 撤回

两种编码都会把 row 保留在 markdown 中，作为审计历史。要永久删除一个 fact，
直接在 markdown 中编辑 fence 并删除该 row。下一次 `extract_facts` cycle
会清除 DB row。

## Disaster recovery

该规则承诺：

```bash
# Snapshot what's there
voltmind stats > /tmp/before.txt

# Wipe and rebuild
voltmind rebuild --confirm-destructive   # v0.32.3 — deletes derived tables
                                       # (pages + content_chunks survive
                                       # the CASCADE-safe design)
                                       # OR manually for v0.32.2:
psql -c 'DELETE FROM facts; DELETE FROM takes; DELETE FROM links; DELETE FROM timeline_entries;'
voltmind sync
voltmind extract all

# Counts match
voltmind stats > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

`test/e2e/system-of-record-invariant.test.ts` 中的 invariant E2E test
会在每次 CI run 中执行这个精确流程。

## Rule for new code

当你增加新的用户知识类别时：

1. **Define the markdown shape.** Fence（`<!--- voltmind:NAME:begin
   --> ... :end -->` table）或 frontmatter field。
2. **Build a parser**，从 markdown 产生结构化数据。
   共享 primitives 见 `src/core/fence-shared.ts`。
3. **Build a writer**，能 round-trip：parse + edit + render 对相同输入产生
   byte-identical markdown。
4. **Add the engine method**，接收 parsed data 并写入 derived table。
   该 method 会进入 CI gate 的 banned-direct-call list。
5. **Add a reconciler:** 一个 cycle phase，遍历 pages、解析 fence，
   并从零重建 derived table。reconciler 是 engine method 的唯一合法调用点；
   用 `// voltmind-allow-direct-insert: <reason>` 明确标注。
6. **Add a round-trip test** 到 `test/e2e/system-of-record-invariant.test.ts`，
   证明 DELETE + reconcile 能 byte-identically 重建表。

`scripts/check-system-of-record.sh` 中的 CI gate 会让任何 PR 失败：
只要它在 reconciler / migration layer 之外增加新的 derived-table writer
直接调用，且没有显式 allow-list comment。

## Related

- `~/.claude/plans/system-instruction-you-are-working-expressive-pony.md`
  — v0.32.2 设计计划（decisions D1-D22 + Q1-Q8，Codex round 1
  and round 2 finds）
- `skills/migrations/v0.32.2.md` — agent-facing migration guide
- `CHANGELOG.md` v0.32.2 entry — release manifesto
- `scripts/check-system-of-record.sh` — 强制执行该规则的 CI gate
