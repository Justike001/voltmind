# Live Sync：保持索引最新

## 目标

brain repo 中每次 markdown 变更都能在几分钟内自动变得可搜索，无需人工介入。

## 用户得到什么

没有它：你修正了 brain 页面里的幻觉，但 vector DB 还在返回旧文本。有了它：编辑会在几分钟内进入搜索，vector DB 自动跟上 repo。

## 实现

### 前置条件：Session Mode Pooler

sync 在每次 import 时使用 `engine.transaction()`。如果 `DATABASE_URL` 指向 Supabase 的 Transaction mode pooler，sync 会抛出 `.begin() is not a function` 并静默跳过大量页面。修复方式是使用 Session mode pooler（6543）或 direct connection（5432）。

### The Primitives

始终串联 sync + embed：

~~~bash
voltmind sync --repo /path/to/brain && voltmind embed --stale
~~~

- `voltmind sync --repo <path>`：一次性增量 sync。
- `voltmind embed --stale`：补齐没有 embedding 的 chunks。
- `voltmind sync --watch --repo <path>`：前台轮询循环，默认 60s。

### Approach 1: Cron Job（推荐）

~~~bash
voltmind sync --repo /data/brain && voltmind embed --stale
~~~

### Approach 2: Long-Lived Watcher

~~~bash
voltmind sync --watch --repo /data/brain
~~~

### Approach 3: Git Hook / Webhook

push 事件触发 sync；GitHub webhook 要验证 `X-Hub-Signature-256`。

### What Gets Synced

sync 只索引可 sync 的 markdown。隐藏路径、`ops/`、`README.md`、`index.md`、`schema.md`、`log.md` 会被排除。

### Sync is Idempotent

并发运行安全。同一 commit 上的两次 sync 因 content hash 相同而 no-op。

## 容易踩坑的地方

1. **总是 sync + embed。** 只 sync 会让新 chunks 没有 embeddings，对 vector search 不可见。
2. **`--watch` 是轮询，不是 stream。** 失败 5 次会退出，需要进程管理器或 cron fallback。
3. **Webhook 需要服务在线。** server down 时 push 会漏 sync，所以也要 cron fallback。

## 如何验证

1. 编辑文件、commit/push，等下一轮 sync 后用 `voltmind search` 搜新文本。
2. 比较 `voltmind stats` page count 和 repo 中可 sync 文件数。
3. embedded chunk count 应接近 total chunk count。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
