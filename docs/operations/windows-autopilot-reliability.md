# Windows Autopilot 运行要点

适用范围：Windows + Supabase/Postgres 的 VoltMind 自动维护部署。本文件是给后续 agent
和运维者的最小上下文；不包含任何连接串、密钥或个人信息。

## 已验证的运行拓扑

```text
Windows Task Scheduler (VoltMind Autopilot)
  -> voltmind.exe autopilot
    -> ChildWorkerSupervisor
      -> voltmind.exe jobs work (Minion worker)
        -> Postgres/Supabase minion_jobs
```

- 这是 Windows 上唯一应运行的 worker 拓扑；不要再另建一个定时 `jobs work` 任务。
- Task 使用 `LogonTrigger`、`IgnoreNew`、`RestartOnFailure` 和无限执行时长；不要添加每分钟
  `CalendarTrigger`，否则手动停止会被下一分钟重新拉起并污染 Task 结果。
- Task 直接执行仓库内的 `bin\voltmind.exe`，工作目录是仓库根目录。
- 该运行模式需要 Postgres；PGLite 不支持独立受管 worker。

## 已解禁 runtime 的接入规则

以下 runtime 现在都是 host-local CLI 能力，但不改变上面的单 worker 拓扑：

- `voltmind agent run ...` 只向 Postgres `minion_jobs` 提交 durable subagent job；由
  Autopilot 已受管的 worker 消费。提交前先运行 `voltmind autopilot --status --json`。
- `voltmind dream ...` 是单次维护 cycle。Windows 的常规维护继续由 Autopilot Task
  驱动；需要验证一次真实队列路径时使用 `voltmind autopilot --verify-once`，不要为
  dream 另建一个周期性 Task。
- `voltmind mounts|remote` 处理联邦拓扑和薄客户端网络路径；`auth|publish|integrations`
  会接触 HTTP server、registry 或外部凭证。它们均在 host 上运行，不经 remote MCP
  暴露队列提交、worker 控制或凭证写入能力。

这些 runtime 依赖 Supabase/Postgres、网络或外部服务；本机 PGLite 开发环境只可覆盖
纯逻辑和 CLI 入口测试，不能替代生产验收。

## 日常运维

```powershell
# 先禁用 Task，再请求 Autopilot 优雅 drain；不强杀。
voltmind autopilot --pause --json

# 清除暂停标记、启用并启动 Task。
voltmind autopilot --start --json

# 唯一的验收入口：同时检查 Scheduler、真实 PID、队列和业务状态。
voltmind autopilot --status --json

# 在源处于 fresh 时，仍通过真实 Minion 队列执行一个完整验证周期。
voltmind autopilot --verify-once --repo <repo-path> --json
```

不要仅使用 `Stop-ScheduledTask`：它不禁用 Task，后续触发或 RestartOnFailure 仍可重启它。
仅在明确要终止时才使用 `autopilot --pause --force`。

## 验收标准

`overall=ready` 仅在以下全部成立时才可信：

- `scheduler_running=true`，Autopilot PID 真实存活且 heartbeat 不过期；
- 受管 worker PID 真实存活，`worker_restart_count` 未持续增加；
- 数据库已连接；
- 没有最近完整成功 cycle 之后产生的 dead job；
- 最近 cycle 不是连续 `cycle_already_running` skip，且 sync 未 `blocked_by_failures`/`partial`；
- 至少已有一次完整成功 cycle。

历史 runtime status 文件不能作为 PID 存活证据。状态实现必须同时核验进程 PID；Task 或 worker
失活时应降级为 `degraded`/`failed`，不得因旧成功记录而显示 `ready`。

## 关键可靠性语义

- 本机 stale sync/cycle lock 只可在 holder PID 已死亡、达到最小年龄保护时原子回收；不可无条件
  force-break。
- 活跃 cycle lock 冲突必须延迟重试，不能标记为 completed。超过重试预算才 dead-letter，并使业务
  状态降级。
- worker lock 续租、cycle lock 心跳和长 `extract` 阶段遇到可恢复连接错误时：受控重连一次后续租；
  重连失败则中止当前 job 并按可重试语义回队，不能让未处理 rejection 杀死 worker。
- `sync` 输入含 NUL/非 UTF-8 或其他解析失败时，隔离失败文件但将本次结果记为
  `blocked_by_failures`；下游 embed 必须为 `blocked`，原因 `upstream_sync_failed`，绝不能报告
  `success / 0`。
- embedding 使用成本上限时必须有已验证的 provider:model 定价；未知价格 fail-closed。

## 已完成的现场验证（2026-07-14）

- 新二进制通过聚焦可靠性回归（35 tests）、`bun run typecheck` 和构建。
- Task 重启后，真实完整 cycle #251、#252、#253 分别在 82.9s、80.8s、79.0s 完成。
- 观察窗口跨过此前 worker `code=58` 的约 16 分钟退出时长：未复现 worker crash、连接关闭、
  stale lock、`cycle_already_running` 或新增 dead job；worker restart count 为 0。

这证明当时的部署已恢复，但不等于外部网络或 Supabase 永远不会故障。遇到新异常时，应先保留日志
和 `autopilot --status --json` 输出，再按上面的状态模型判断；不要把“Task 已注册”或“进程存在”
单独当作业务验收。
