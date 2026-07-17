# 参考 Cron 调度

## 目标

生产级 brain 会运行 20 多个周期性任务，让它保持活跃、最新并持续复利。本指南说明调度、模式和设置方式。

## 用户得到什么

没有它：brain 只在你手动摄取数据时更新，页面过期、实体稀薄、引用断裂，agent 用旧上下文回答。

有了它：brain 会自我维护。邮件、社交、日历和会议自动流入；薄页面夜间补全；破损引用被修复；你醒来时 brain 比入睡前更聪明。

## 调度

| 频率 | 任务 | Brain 交互 | Recipe |
|-----------|-----|-------------------|--------|
| 每 30 分钟 | Email monitoring | 搜索发件人，更新人物页 | [email-to-brain](../../recipes/email-to-brain.md) |
| 每 30 分钟 | X/Twitter collection | 创建/更新 media 页面，抽取实体 | [x-to-brain](../../recipes/x-to-brain.md) |
| 工作日每天 3 次 | Meeting sync | 完整摄取 + 参会者传播 | [meeting-sync](../../recipes/meeting-sync.md) |
| 每周 | Calendar sync | daily 文件 + 参会者 enrich | [calendar-to-brain](../../recipes/calendar-to-brain.md) |
| 每天早上 | Morning briefing | 搜索日历参会者、交易状态、活跃线程 | [briefing skill](../../skills/briefing/SKILL.md) |
| 每周 | Brain maintenance | `voltmind doctor`、embed stale、孤儿检测 | [maintain skill](../../skills/maintain/SKILL.md) |
| 每晚 | Dream cycle | 实体 sweep、补薄弱处、修引用 | 见下文 |

## 实现：设置 Cron Jobs

~~~bash
# Email collector — every 30 minutes
*/30 * * * * cd /path/to/email-collector && node email-collector.mjs collect && node email-collector.mjs digest

# X/Twitter collector — every 30 minutes
*/30 * * * * cd /path/to/x-collector && node x-collector.mjs collect >> /tmp/x-collector.log 2>&1

# Meeting sync — 10 AM, 4 PM, 9 PM on weekdays
0 10,16,21 * * 1-5 cd /path/to/meeting-sync && node meeting-sync.mjs >> /tmp/meeting-sync.log 2>&1

# Calendar sync — Sundays at 10 AM
0 10 * * 0 cd /path/to/calendar-sync && node calendar-sync.mjs --start $(date -v-7d +%Y-%m-%d) --end $(date +%Y-%m-%d)

# Brain health — weekly Mondays at 6 AM
0 6 * * 1 voltmind doctor --json >> /tmp/voltmind-health.log 2>&1 && voltmind embed --stale

# Dream cycle — nightly at 2 AM
0 2 * * * /path/to/dream-cycle.sh
~~~

### Quiet Hours Gate（强制）

任何会发送通知的 cron job 都必须先检查 quiet hours。完整模式见 [Quiet Hours](quiet-hours.md)。

~~~bash
# In every cron script:
if ! bash scripts/quiet-hours-gate.sh; then
  mkdir -p /tmp/cron-held
  echo "$OUTPUT" > /tmp/cron-held/$(basename "$0" .sh).md
  exit 0
fi
# Not quiet hours — send normally
~~~

### 感知旅行的时区处理

agent 会读取日历中的航班、酒店和 out-of-office 块来推断当前位置和时区。所有时间都以用户当前本地时区展示。

~~~
// Example: user flew to Tokyo
// 2 PM Pacific = 3 AM Tokyo = quiet hours
// Hold the notification, fold into morning briefing

get_user_timezone():
  calendar = voltmind search "flight" --type calendar --recent 7d
  if recent_flight:
    return infer_timezone(flight.destination)
  return config.default_timezone  // fallback: US/Pacific
~~~

旅行时，本来会在家中清醒时间触发、但落在目的地睡眠时间的通知会被 hold，并合并进下一次 morning briefing，不需要改配置。

## Dream Cycle

最重要的 cron job。它在你睡觉时运行。

### 它做什么

~~~
dream_cycle():
  // Phase 1: Entity Sweep
  // Phase 2: Fix Broken Citations
  // Phase 3: Consolidate Memory
  // Phase 4: Sync
  voltmind sync --no-pull --no-embed
  voltmind embed --stale
~~~

### 设置 Dream Cycle

**OpenClaw:** 默认随 DREAMS.md 技能发货，light、deep、REM 三个阶段会在 quiet hours 自动运行。

**Hermes Agent:**
~~~bash
/cron add "0 2 * * *" "Dream cycle: search today's sessions for
  entities I mentioned. For each person, company, or idea: check
  if a brain page exists (voltmind search), create or update it if
  thin. Fix any broken citations. Then consolidate: read MEMORY.md,
  promote important signals, remove stale entries."
  --name "nightly-dream-cycle"
~~~

**Claude Code / Custom agents:** 创建脚本：
~~~bash
#!/bin/bash
# dream-cycle.sh

echo "Dream cycle starting at $(date)"
voltmind doctor --json | jq '.checks[] | select(.status=="warn")'
voltmind embed --stale
echo "Dream cycle complete at $(date)"
~~~

## 容易踩坑的地方

1. **dream cycle 不是可选项。** 没有它，每次对话都有信号泄漏。
2. **每个通知 job 都要 quiet hours gate。** 一次凌晨 3 点通知就足以让用户关闭系统。
3. **不要过度 cron。** 先从 email、dream cycle、brain health 开始，再随集成增加。
4. **时区变化应自动。** 不要让用户旅行时手动重配。
5. **held messages 必须被 morning briefing 捡起。** 否则信息会丢。

## 如何验证

1. 把 quiet hours 设为当前小时，运行通知 cron，输出应进入 `/tmp/cron-held/`。
2. 手动运行 dream cycle，检查薄页面和破损引用。
3. 等 30 分钟检查 email digest。
4. 检查 held messages 是否出现在 briefing。
5. 运行 `voltmind doctor --json`，所有检查应通过。

---

*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。另见：[Quiet Hours](quiet-hours.md)、[Operational Disciplines](operational-disciplines.md)*
