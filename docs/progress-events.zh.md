# Progress events

这是 `voltmind` 在批量命令带 `--progress-json` 运行时写入 `stderr` 的 JSONL 进度流规范参考。自 v0.15.2 起稳定。只允许 additive changes；没有 major version bump 不会重命名或移除字段。

大多数人类不会读这个页面。解析进度的 agents 会读。

## 什么时候会收到这些 events？

以下命令在设置 `--progress-json` 时会流式输出 events：

- `voltmind doctor`（DB checks、JSONB integrity、markdown body completeness、integrity sample）
- `voltmind orphans`
- `voltmind embed`
- `voltmind files sync`
- `voltmind export`
- `voltmind extract [links|timeline|all]`（fs 或 db source）
- `voltmind import`
- `voltmind sync`
- `voltmind migrate --to …`
- `voltmind repair-jsonb`
- `voltmind check-backlinks`
- `voltmind lint`
- `voltmind integrity auto`
- `voltmind eval`
- `voltmind apply-migrations`（orchestrator + 每个 child command）

非批量命令（`stats`, `graph-query`, `get`, `put` 等）不会发出 events，因为它们通常不到一秒就返回。

## Channel

- Progress events：**`stderr`**，每行一个 JSON object，以 `\n` 结尾。
- Data results（各命令的 `--json` payload）：**`stdout`**。
- 最终人类摘要：**`stdout`**。

Agents 可以安全地捕获 stdout 做结果解析，并单独读取 stderr 获取进度。

## Flags

| Flag | Behavior |
|---|---|
| *(none)* | Auto。TTY：用 `\r` 重写单行。非 TTY：stderr 上每个 event 一行。 |
| `--progress-json` | 强制 stderr 使用 JSON-lines 模式（本文件）。 |
| `--quiet` | 完全抑制进度。Warnings 和 final output 仍会打印。 |
| `--progress-interval=<ms>` | 覆盖 tick emits 的最小间隔（默认 1000）。 |

Global flags 会在 command dispatch 前由 `src/core/cli-options.ts` 解析，因此 `voltmind --progress-json doctor` 与 `voltmind doctor --progress-json` 行为相同（后者也可用，因为 per-command parsers 会通过共享 `CliOptions` singleton 看见该 flag）。

## Event types

每个 event 都是单行 JSON object，包含这些公共字段：

| Field | Type | Notes |
|---|---|---|
| `event` | string | 其一：`start`, `tick`, `heartbeat`, `finish`, `abort`。 |
| `phase` | string | 机器稳定的 snake_case、dot-separated。见下方 “Phase names”。 |
| `ts` | ISO 8601 UTC string | event 发出时间。 |
| `elapsed_ms` | number | 自 phase 开始以来的毫秒数。出现在 `tick`/`heartbeat`/`finish`/`abort`。 |

### `start`

phase 开始时发出。

```json
{"event":"start","phase":"doctor.db_checks","ts":"2026-04-20T12:34:56.789Z"}
{"event":"start","phase":"import.files","total":52000,"ts":"2026-04-20T12:34:56.789Z"}
```

可选字段：

- `total` — 如果开始时已知，则为总 item 数。

### `tick`

迭代期间周期性发出。受时间和 item gate 控制：reporter 不会比 `minIntervalMs`（默认 1000）和 `minItems`（默认 `max(10, ceil(total/100))`）更频繁地 emit。

```json
{"event":"tick","phase":"orphans.scan","done":15000,"total":52000,"pct":28.8,"elapsed_ms":4200,"eta_ms":10300,"ts":"..."}
```

字段：

- `done` — 本 phase 已完成 items。
- `total` — 总 items（如果已知）。当 scan 一开始没有 total（例如 streaming iterator）时省略。
- `pct` — `done/total * 100`，一位小数。`total` 未知时省略。
- `eta_ms` — 根据已观察速率估算到 `done === total` 的剩余毫秒数。`total` 未知时省略。
- `note` — 可选字符串，当前 item（例如 slug 或 filename）。

### `heartbeat`

用于不迭代的长时间单操作（例如对 50K-row table 的 `SELECT`）。没有 `done`，没有 `total`，只是表示工作仍在继续。

```json
{"event":"heartbeat","phase":"doctor.markdown_body_completeness","note":"scanning pages for truncation…","elapsed_ms":1000,"ts":"..."}
```

### `finish`

phase 正常完成时发出。

```json
{"event":"finish","phase":"import.files","done":52000,"total":52000,"elapsed_ms":187000,"ts":"..."}
```

### `abort`

由单个 process-level SIGINT/SIGTERM handler 发出，该 handler 跟踪所有 live phases。`abort` 之后，该 phase 不再发出 events。

```json
{"event":"abort","phase":"doctor.markdown_body_completeness","reason":"SIGINT","elapsed_ms":5300,"ts":"..."}
```

## Phase names

Phases 使用 `snake_case.dot.path` 命名。新的 reporter 从 root 开始；`child()` composition 会追加到 parent 当前 phase，因此调用 import 的 sync 会发出 `sync.import.<file>`，而不是 `import.<file>`。

v0.15.2 发布的稳定 phase names：

- `doctor.db_checks`（所有 DB-side doctor checks 的 umbrella）
- `orphans.scan`
- `embed.pages`
- `extract.links_fs`, `extract.timeline_fs`, `extract.links_db`, `extract.timeline_db`
- `import.files`
- `sync.deletes`, `sync.renames`, `sync.imports`
- `migrate.copy_pages`, `migrate.copy_links`
- `repair_jsonb.run`, `repair_jsonb.<table>.<column>`
- `backlinks.scan`
- `lint.pages`
- `integrity.auto`
- `eval.single`, `eval.ab`
- `export.pages`
- `files.sync`

通过 `child()` 暴露的 sub-phases：

- `sync.import.files` — 嵌套在 sync 内
- `apply_migrations.v0_12_2.jsonb_repair` — 嵌套在 orchestrator 内

## Subprocess inheritance

当 parent CLI 启动 `voltmind …` 子进程（主要在 `src/commands/migrations/*`）时，global flags（`--quiet`, `--progress-json`, `--progress-interval`）会通过 `src/core/cli-options.ts` 中的 `childGlobalFlags()` helper 传入 child 的 argv。Child stderr 通过 `stdio: 'inherit'` 直接透传，因此 event stream 是 parent stderr 上合并后的 JSONL feed。

一个例外是 `migrations/v0_12_2.ts` 中捕获 child stdout 的 orchestrator phase（`repair-jsonb --dry-run --json` 用于 verification），它不会传 `--progress-json`，以免 stdout 污染破坏 orchestrator 的 `JSON.parse`。其 stdio 显式为 `['ignore', 'pipe', 'inherit']`，所以 stderr 仍然透传。

## Minion jobs

`voltmind jobs work`（Minion worker daemon）把进度保存在 DB 中，而不是 stderr。每个运行 bulk core（embed、sync、extract、import、backlinks）的 Minion handler 都会在迭代中调用 `job.updateProgress({done, total, …})`。Agents 通过 `get_job_progress` MCP operation 或 `voltmind jobs get <id>` 读取每个 job 的进度。

`jobs work` daemon 自身只为 liveness 输出 coarse one-line-per-job stderr。Per-page detail 存在 DB 中。

## Compatibility

- **Added**：只允许新增。新的 event type、新字段、新 phase name 都安全。Agents 必须忽略未知字段和未知 event types。
- **Removed/renamed**：没有 major version bump 绝不移除或重命名。
- **Schema changes**：会在 `CHANGELOG.md` 和 `skills/migrations/v<next>.md` 中公告。

如果你的 agent 依赖此 schema，且遇到意外行为，请带上收到的 event 和期望行为提 issue。
