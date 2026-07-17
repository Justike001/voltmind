# 多来源 brains

**一个 voltmind 数据库可以容纳多个知识 repo。** 每个 repo 是一个 `source`：brain 中的逻辑 brain，拥有自己的 slug namespace、sync 状态和 federation policy。

## 三种场景

### 1. 统一知识召回（wiki + gstack）

个人 wiki 和 `gstack` checkout 都属于你，也都应该被 agent 跨源召回。

~~~bash
voltmind sources add gstack --path ~/.gstack --federated
cd ~/.gstack && voltmind sources attach gstack
voltmind sync --source gstack
~~~

结果：wiki 页面和 gstack plans 分属不同 source_id 与 slug namespace，但共享搜索入口。

### 2. 按用途隔离的 brains（yc-media + garrys-list）

不同内容 pipeline 共享后端，但搜索不应混在一起。federation 默认隔离，按需显式跨源搜索。

~~~bash
voltmind sources add yc-media --path ~/yc-media --no-federated
voltmind sources add garrys-list --path ~/writing --no-federated
voltmind search "tech layoffs" --source yc-media,garrys-list
~~~

### 3. 混合模式（wiki federated + sessions isolated）

主 wiki 与可信 source federated；session transcripts 放进独立 source，避免淹没搜索结果。

## Resolution priority

1. 显式 `--source <id>`。
2. `VOLTMIND_SOURCE` 环境变量。
3. 当前目录或祖先目录的 `.voltmind-source`。
4. `local_path` 包含 CWD 的注册 source。
5. brain-level default。
6. seeded `default` source。

## Federation flag

| Value | Meaning |
|-------|---------|
| `true` | 参与未限定的 `voltmind search "X"`。 |
| `false` | 仅在显式 `--source <id>` 或限定引用时搜索。 |

## Commands

~~~
voltmind sources add <id> --path <p> [--name <n>] [--federated|--no-federated]
voltmind sources list [--json]
voltmind sources remove <id> [--yes] [--dry-run] [--keep-storage]
voltmind sources rename <id> <new-name>
voltmind sources default <id>
voltmind sources attach <id>
voltmind sources detach
voltmind sources federate <id>
voltmind sources unfederate <id>
~~~

## Agent 引用格式

多源结果必须用 `[source-id:slug]` 形式引用。source id 不可变，rename 只改显示名。

## 写入特定 source

~~~bash
voltmind put-page topics/ai ... --source wiki
cd ~/.gstack && voltmind put-page plans/multi-repo ...
~~~

## 升级现有 brain

`voltmind upgrade` 自动运行 v16 + v17 migrations。现有页面进入 `source_id='default'`，直到添加第二个 source 前行为不变。

## Not in v0.18.0

- Session transcript ingest — v0.18。
- Per-source retention/TTL — v0.18。
- ACL enforcement via caller-identity — v0.17.1。
- GitHub import bootstrap — core plumbing 稳定后的 patch release。
