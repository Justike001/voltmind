# Queue operations runbook

“我的 queue 看起来卡住了，该跑什么？”下面命令按通常排查顺序排列。v0.19.1 随一次生产事故后发布，当时 queue 卡住 90 多分钟才被发现。

## 第一信号：jobs 没有运行

~~~bash
voltmind doctor --json | jq '.checks[] | select(.name == "queue_health")'
~~~

`queue_health` 标记两类模式：

- **stalled-forever**：active job 的 `started_at` 早于 1 小时。
- **waiting-depth**：某个 per-name queue 深度超过 10（可用 `VOLTMIND_QUEUE_WAITING_THRESHOLD` 覆盖）。

## Triage commands

~~~bash
voltmind jobs list --status active
voltmind jobs list --status waiting --limit 50
voltmind jobs get <id>
~~~

## Rescue actions（按升级顺序）

~~~bash
voltmind jobs cancel <id>
voltmind jobs delete <id>
voltmind jobs smoke --wedge-rescue
~~~

## 每个 subcheck 的含义

- **stalled-forever**：worker 已 claim 并开始执行，但持有 row 超过一小时。取消它。
- **waiting-depth**：submitter 堆积速度超过 worker 消化速度。给提交加 `--max-waiting N`，或提高阈值。

## Self-check：worker 是否在运行？

~~~bash
voltmind jobs list --status active | head -5
~~~

如果列表为空但提交不断堆积，说明没有 worker claim。启动一个：

~~~bash
VOLTMIND_ALLOW_SHELL_JOBS=1 voltmind jobs work --concurrency 4
~~~

## v0.20+ 跟进

- B7：`minion_workers` heartbeat table，用于真实 liveness。
- B3：`voltmind doctor --fix` 学会救 queue wedges。
