# Pre-commit hook for brain repos (v0.22.4+)

`voltmind frontmatter install-hook` 会在你的 brain source repo 中安装一个 git
pre-commit hook，对 staged `.md` 和 `.mdx` 文件运行
`voltmind frontmatter validate`。格式错误的 frontmatter 会阻止 commit。
可用 `git commit --no-verify` 绕过。

## What the hook catches

与 `frontmatter-guard` skill 和 `voltmind doctor` 的 `frontmatter_integrity`
subcheck 报告相同的七类验证：

| Code              | What it catches                                                     |
|-------------------|---------------------------------------------------------------------|
| `MISSING_OPEN`    | 文件不是以 `---` 开头                                               |
| `MISSING_CLOSE`   | 第一个 heading 前没有 closing `---`                                 |
| `YAML_PARSE`      | YAML 解析失败（syntax 或 structure）                                |
| `SLUG_MISMATCH`   | frontmatter 中的 `slug:` 与 path-derived slug 不匹配                |
| `NULL_BYTES`      | 内容任意位置存在 binary corruption（`\x00`）                        |
| `NESTED_QUOTES`   | `title: "outer "inner" outer"` 这种会破坏 YAML 的形态               |
| `EMPTY_FRONTMATTER` | `---` ... `---` 中间没有有意义内容                                |

## Install

对所有已注册且是 git repos 的 sources：

```bash
voltmind frontmatter install-hook
```

对单个 source：

```bash
voltmind frontmatter install-hook --source <id>
```

强制覆盖已有 pre-commit hook（写入 `.bak`）：

```bash
voltmind frontmatter install-hook --force
```

hook 会落在 `<source>/.githooks/pre-commit`。如果 `core.hooksPath` 未设置，
安装也会运行 `git config core.hooksPath .githooks`，这样 hook 无需手动 git
config 就会生效。

## Bypass

标准 git 逃生通道：

```bash
git commit --no-verify
```

这会跳过 ALL pre-commit hooks。谨慎使用 — 下次用户运行 `voltmind doctor` 时，
问题仍会浮现。

## Uninstall

```bash
voltmind frontmatter install-hook --uninstall
```

如果安装期间保存过 `.bak`，会将其恢复为 active hook。否则会干净地移除 hook。

## Behavior on machines without voltmind installed

hook script 会检查 `$PATH` 上是否有 `voltmind`。缺失时，它会向 stderr 打印一行
warning 并以 0 退出 — 不会只因为开发者本地没安装 voltmind 就阻止 commit。
一旦安装了 voltmind，hook 会恢复阻止 malformed pages。

## For downstream agent forks

如果你的 OpenClaw 在一个不是 brain repo 本身的 host repo 中包装 voltmind，
你可能需要单独的 hook 策略：

- **Brain repo IS the host repo**（voltmind skills + brain pages 在同一 repo）：
  按上文通过 `voltmind frontmatter install-hook` 安装。
- **Brain repo is a separate registered source**（例如 `~/brain` 注册为 source，
  host repo 是 `~/agent-fork`）：只在 brain repo 中安装；
  agent-fork code 不需要这个 hook。
- **Brain repo is auto-generated**（例如由 sync daemon 写入 bucket）：
  完全跳过 hook；改在 writer 处通过
  `import { writeBrainPage } from 'voltmind/brain-writer'` gate
  （计划在后续 release 中提供；当前 CLI 是 surface）。

## How it fits into the broader frontmatter pipeline

```
agent writes a page         git commit                 doctor scan
       ↓                          ↓                          ↓
[source content]   →  [pre-commit hook validates]   →  [frontmatter_integrity check]
       ↓                          ↓                          ↓
  raw file on disk       blocks malformed commits     surfaces existing issues
                                                             ↓
                                                  `voltmind frontmatter validate
                                                   <source-path> --fix`
                                                   (writes .bak backups)
```

hook 是 write-time gate；doctor 是 audit gate；CLI 是修复工具。它们共享
`parseMarkdown(..., {validate:true})` 作为判断 malformed 的单一事实来源。
