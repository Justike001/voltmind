# Plugin authors guide (v0.15)

`voltmind` 通过 `VOLTMIND_PLUGIN_PATH` 从本 repo 外发现 subagent definitions。如果你维护 downstream agent 或私有工具，并想随它发布自定义 subagents，把 plugin 目录放到该 env path 上。

本指南面向 plugin authors；CLI 用户通常不需要阅读。

## Minimum viable plugin

~~~
/path/to/my-plugin/
├── voltmind.plugin.json
└── subagents/
    └── my-summarizer.md
~~~

`voltmind.plugin.json` 和 subagent markdown 使用原始格式即可。

## Turning it on

~~~bash
export VOLTMIND_PLUGIN_PATH="/path/to/my-plugin"
voltmind jobs work
voltmind agent run "summarize meetings/2026-04-20" --subagent-def my-summarizer
~~~

多个 plugins 用冒号分隔，像 `$PATH` 一样。

## Rules（严格设计）

**Path policy.** 只接受绝对路径；相对路径、`~` 前缀和 URL-style path 会被拒绝。

**Collision policy.** 两个 plugin 同名 subagent 时，`VOLTMIND_PLUGIN_PATH` 中先出现者胜出。

**Trust policy.** v0.15 中 plugin 只能发布 subagent definitions：不能声明新工具、不能扩展 allow-list、不能覆盖安全 flag；`allowed_tools` 必须是 derived brain registry 的子集。

## `voltmind.plugin.json`

| field | type | required | notes |
|---|---|---|---|
| `name` | string | yes | 人类可读 plugin id。 |
| `version` | string | yes | plugin semver。 |
| `plugin_version` | string | yes | v0.15 必须等于 `"voltmind-plugin-v1"`。 |
| `subagents` | string | no | 子目录名，默认 `subagents`。 |
| `description` | string | no | 未来 list 中展示。 |

## Subagent definition files

普通 markdown + YAML frontmatter；body 是 system prompt。frontmatter 控制运行行为。

## 会咬你的 Caveats

1. **运行中 plugin definition 不会变化。** loader 只在 worker startup 读一次。
2. **audit JSONL 是本地的。** worker 和 CLI 不同主机时看不到 heartbeat。
3. **tool calls 总是 `ctx.remote = true`。** 本地 CLI 调用也一样。
4. **`put_page` 写入受 namespace 限制。** subagent 只能写自己的 namespace。

## Example: downstream-OpenClaw plugin

~~~
~/your-openclaw/
└── voltmind-plugin/
    ├── voltmind.plugin.json
    └── subagents/
~~~
