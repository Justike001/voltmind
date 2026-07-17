# Plugin handlers：注册 host-specific Minion handlers

VoltMind 的 Minion worker 内置七个 handler：`sync`、`embed`、`lint`、`import`、`extract`、`backlinks`、`autopilot-cycle`。它们覆盖 voltmind CLI 自身执行的后台操作。

Host 平台通过 plugin bootstrap 注册自己的 handlers。handlers 是代码，由 worker 加载，信任模型和 host repo 中其他代码相同。

## 为什么是代码，不是数据

早期设计使用 shell command 数据文件；这会形成持久 RCE 面。现在 handlers 必须是显式 import、经过 code review 的代码。

## Plugin contract

~~~ts
import { MinionQueue, MinionWorker } from 'voltmind/minions';
import type { BrainEngine } from 'voltmind/engine';

async function main() {
  const engine: BrainEngine = /* your engine setup */;
  await engine.connect({});
  const worker = new MinionWorker(engine, { queue: 'default' });
  worker.register('ea-inbox-sweep', async (ctx) => {
    const slot = ctx.data.slot ?? new Date().toISOString();
    return { swept: true, slot };
  });
  await worker.start();
}
~~~

## Handler contract

每个 handler 接收 `MinionJobContext`：包含 `data`、`job`、`signal` 和 `inbox`。成功时返回可序列化对象；失败时 throw，由 worker 根据 `max_attempts` 记录并重试。

**Abort cooperation.** `ctx.signal.aborted` 为 true 时要优雅结束；worker 等 30s 后才 SIGKILL。

**Idempotency.** queue 在 DB 层用 `idempotency_key` 去重，不必担心 cron 重复提交。

## VoltMind migration flow

v0.11.0 migration orchestrator 会发现非内置 handler，并把 TODO 写到 `~/.voltmind/migrations/pending-host-work.jsonl`。host agent 读取这些 TODO、添加 handler registration、部署 worker、再运行 `voltmind apply-migrations --yes` 完成改写。

## Trust boundary

handler code 在 worker process 内运行，权限与 host binary 相同；没有额外提升，也没有 runtime sandbox。按生产数据代码的标准 review handler PR。

## Related

- `skills/conventions/cron-via-minions.md`
- `skills/migrations/v0.11.0.md`
- `skills/minion-orchestrator/SKILL.md`
