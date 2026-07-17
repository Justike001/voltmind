# Upgrades and Auto-Update Notifications

## 目标

用户以对话方式获知新的 VoltMind 功能，agent 在得到明确许可后带用户完成 upgrade，并执行 post-upgrade migrations，让新版本真正可用。

## 用户得到什么

没有它：VoltMind 发布更新但没人知道，用户停留在旧版本；或者只运行 `voltmind upgrade` 却跳过后续步骤。有了它：agent 每天检查更新，用收益导向 bullet 说明价值，等待明确许可，然后完整执行升级流程。

## 实现

### Check（cron initiated）

~~~
check_for_update():
  result = run("voltmind check-update --json")
  if not result.update_available:
    exit_silently()
  message = compose_upgrade_message(current, latest, changelog)
  send_to_user(message, respect_quiet_hours=true)
~~~

### Upgrade Message

升级信息要卖价值：先讲用户现在能做什么，而不是哪些文件变化。

### Handling Responses

| User says | Action |
|-----------|--------|
| yes / y / sure / ok / do it / upgrade | 运行完整 upgrade flow |
| not now / later / skip / snooze | 下个周期再检查 |
| weekly | 存偏好，改成每周 |
| daily | 存偏好，改回每天 |
| stop / unsubscribe / no more | 关闭 cron，并说明如何恢复 |

**永远不要自动升级。** 必须等待明确确认。

### Full Upgrade Flow

~~~
full_upgrade():
  run("voltmind upgrade")
  for skill in find("skills/*/SKILL.md"): read_and_internalize(skill)
  read("docs/VOLTMIND_SKILLPACK.md")
  read("docs/VOLTMIND_RECOMMENDED_SCHEMA.md")
  for version in range(old_version, new_version):
    migration = find(f"skills/migrations/v{version}.md")
    if migration exists: read_and_execute(migration)
  summarize_to_user(actions_taken)
~~~

### Migration Files

migration files 位于 `skills/migrations/vX.Y.Z.md`，是 agent instructions，不是盲目执行的脚本。

### Cron Registration

~~~
Name: voltmind-update-check
Default schedule: 0 9 * * *
Weekly schedule: 0 9 * * 1
~~~

### Frequency Preferences

默认 daily。存入 agent memory 的 `voltmind_update_frequency: daily|weekly|off`，并持久化到 `~/.voltmind/update-state.json`。

### Standalone Skillpack Users

直接复制 skillpack 的用户可用远端 version markers 检查更新：

~~~bash
curl -s https://raw.githubusercontent.com/garrytan/voltmind/master/docs/VOLTMIND_SKILLPACK.md | head -1
~~~

## 容易踩坑的地方

1. **永远不要 auto-install。** 必须等用户说 yes。
2. **migration files 是 agent instructions，不是 scripts。** agent 要读懂并适配环境。
3. **check-update 应该每天 cron。** 没有更新时保持完全静默。

## 如何验证

1. 运行 `voltmind check-update --json`，确认版本和 update_available 正确。
2. 检查 `skills/migrations/` 文件命名和内容。
3. 有更新时测试完整 upgrade flow：upgrade、重读 skills、跑 migrations、sync schema、报告。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
