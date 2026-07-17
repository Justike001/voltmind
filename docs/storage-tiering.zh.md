# Storage Tiering：db-tracked 与 db-only 目录

## Overview

VoltMind 支持 storage tiering，用来把受版本控制的内容与大量机器生成数据分开。这可以避免 git 仓库被自动生成的大量内容撑大，同时仍在数据库中保留这些内容。

> 命名说明：v0.22.11 之前使用的键是 `git_tracked` / `supabase_only`。现在的规范名称是 `db_tracked` / `db_only`（engine-agnostic，同时适用于 PGLite 和 Postgres）。废弃键仍会加载，但每个进程会警告一次。当该路径落地后，可运行 `voltmind doctor --fix` 自动重命名。

## Configuration

在 brain 仓库根目录的 `voltmind.yml` 中添加 `storage` section：

```yaml
storage:
  # Directories that are version-controlled (human-edited, committed to git).
  db_tracked:
    - people/
    - companies/
    - deals/
    - concepts/
    - yc/
    - ideas/
    - projects/

  # Directories persisted via the brain database only (bulk machine-generated
  # content). Written to disk as a local cache but not committed to git;
  # `voltmind sync` auto-manages .gitignore for these paths. `voltmind export
  # --restore-only` repopulates missing files from the database.
  db_only:
    - media/x/
    - media/articles/
    - meetings/transcripts/
```

路径要求：

- 每个目录都必须以 `/` 结尾，以符合规范形式。validator 会自动规范化缺失的尾随斜杠（一次性 info note 会显示修改内容）。
- 一个目录不能同时出现在两个 tier 中。这是 tier-overlap error，`loadStorageConfig` 会抛出 `StorageConfigError`。请编辑 `voltmind.yml` 移除重叠后再试。

## Behavior Changes

### 1. `voltmind sync` — 自动管理 .gitignore

存在 storage configuration 时，`voltmind sync` 会在每次成功 sync 后自动管理 `.gitignore` 条目：

- 将缺失的 `db_only` 目录模式添加到 `.gitignore`。
- 幂等，重复运行不会添加重复条目。
- 使用稳定注释头，便于 grep managed block。
- `--dry-run` 时跳过（预览模式不修改磁盘）。
- `blocked_by_failures` 状态时跳过（sync state 不一致）。
- 当 repo 是 git submodule 时跳过（`.git` 是文件而非目录），因为 submodule 的 .gitignore 修改不会在 parent updates 后保留。会解释 warning。
- 设置 `VOLTMIND_NO_GITIGNORE=1` 时完全跳过（面向共享 repo 的 escape hatch，让 maintainer 要求 voltmind 不碰 .gitignore）。
- 写权限被拒等失败会被捕捉并记录，绝不会让 sync 崩溃。

示例 `.gitignore` 添加：

```gitignore
# Auto-managed by voltmind (db_only directories)
media/x/
media/articles/
meetings/transcripts/
```

### 2. `voltmind export --restore-only` — 重新填充缺失的 db_only 文件

```bash
# Restore only missing db_only files from the database.
voltmind export --restore-only --repo /path/to/brain

# Filter by page type.
voltmind export --restore-only --type media --repo /path/to/brain

# Filter by slug prefix.
voltmind export --restore-only --slug-prefix media/x/ --repo /path/to/brain

# Combine filters.
voltmind export --restore-only --type media --slug-prefix media/x/ --repo /path/to/brain
```

`--restore-only` flag：

- 通过 `--repo` → typed `sources.getDefault()` → hard error 的链条解析 repoPath。绝不会退回当前目录。
- 只导出匹配 `db_only` patterns 且磁盘上缺失的 pages。
- 适合容器重启恢复和 fresh clones。

### 3. `voltmind storage status` — storage-tier health dashboard

```bash
# Human-readable status.
voltmind storage status --repo /path/to/brain

# JSON output for scripts and orchestrators.
voltmind storage status --repo /path/to/brain --json
```

输出包括：

- 按 storage tier 统计的总 page count。
- 按 tier 统计的磁盘使用量。
- 需要 restore 的缺失文件（显示前 10 个；完整列表在 `--json` 中）。
- 配置 validation warnings。
- 当前 tier 目录列表。

示例输出：

```
Storage Status
==============

Repository: /data/brain
Total pages: 15,243

Storage Tiers:
-------------
DB tracked:     2,156 pages
DB only:        12,887 pages
Unspecified:    200 pages

Disk Usage:
-----------
DB tracked:     45.2 MB
DB only:        2.1 GB

Missing Files (need restore):
-----------------------------
  media/x/tweet-1234567890
  media/x/tweet-0987654321
  ... and 47 more

Use: voltmind export --restore-only --repo "/data/brain"

Configuration:
--------------
DB tracked directories:
  - people/
  - companies/
  - deals/

DB-only directories:
  - media/x/
  - media/articles/
  - meetings/transcripts/
```

## Validation

`loadStorageConfig` 会在解析后运行 `normalizeAndValidateStorageConfig`：

- 自动修复（静默，并用一次性 info note 显示变化）：
  - 添加缺失的尾随 `/`：`'media/x'` → `'media/x/'`。
- 抛出 `StorageConfigError`（caller 看到干净的 exit-1 和可操作消息）：
  - 同一目录同时位于 `db_tracked` 和 `db_only`（routing ambiguous）。

## Use cases

### Brain repository scaling

非常适合跨过 50K-200K+ 文件规模的 brain repositories：

- 核心知识（people、companies、deals）仍由 git 跟踪。
- 大体量数据（tweets、articles、transcripts）移入 db_only。
- git repo 更小，开发保持快速。
- 完整数据仍可通过数据库访问。

### Container-based deployments

对 ephemeral container environments 很关键：

- Git repo 只包含必要文件。
- 容器重启不会丢失 db_only 数据。
- `voltmind export --restore-only` 可在需要时快速恢复 bulk files。
- 本地磁盘作为 cache layer。

### Multi-environment consistency

支持跨环境一致的数据访问：

- Development：小 git clone，按需 restore bulk data。
- Production：通过数据库访问完整 dataset，选择性本地缓存。
- CI/CD：只用 git-tracked data 跑快速测试。

## Migration strategy

1. **评估当前仓库**：用 `voltmind storage status` 理解当前分布。
2. **规划目录结构**：识别哪些目录应为 db_tracked，哪些应为 db_only。
3. **创建 `voltmind.yml`**：在仓库根目录添加 storage configuration。
4. **用 dry-run 测试**：`voltmind sync --dry-run` 验证行为；dry-run 不会碰 `.gitignore`。
5. **运行真实 sync**：`voltmind sync` 成功后会自动更新 `.gitignore`。
6. **验证 restore**：针对一个小 db_only 目录测试 `voltmind export --restore-only --repo .`。

## Best practices

- **Directory naming**：storage paths 以 `/` 结尾（规范形式）。validator 会在你忘记时规范化。
- **Start small**：先把明显由机器生成的目录放入 `db_only`。
- **Address validation errors**：tier overlap 是错误，不是 warning。sync 前先修复。
- **Test restore**：定期在 staging environments 测试 `--restore-only`。
- **Document decisions**：在 `voltmind.yml` 中注释 tier 选择原因。

## PGLite engine note

在 PGLite engine（voltmind 的本地 embedded Postgres）上，db_only pages 所在的“DB”就是 voltmind 用于所有内容的本地文件。`.gitignore` housekeeping 仍有帮助（避免 bulk content 进入 git history），但 offload-to-DB 的承诺在技术上是空的。检测到该 engine 时，会每进程 soft-warn 一次。要获得完整 tiering，请用 `voltmind migrate --to supabase` 迁移到 Postgres。

## Compatibility

- **Backward compatible**：没有 `voltmind.yml` 的系统照常工作。
- **Progressive enhancement**：需要时再添加配置。
- **Database unchanged**：无论 tier 如何，所有数据仍保留在 Postgres 中。
- **Existing workflows**：保留全部现有 `sync` 和 `export` 行为。
- **Deprecated keys**：`git_tracked` / `supabase_only` 仍会加载，并每进程 warning 一次。
