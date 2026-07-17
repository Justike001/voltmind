# Quiet Hours 与时区感知投递

## 目标

睡眠时间 hold 所有通知，把 held messages 合并进 morning briefing，并在用户旅行时自动调整。

## 用户得到什么

没有它：凌晨 3 点 cron ping，一次糟糕通知就可能让用户关闭整个系统。有了它：brain 夜间工作，但通知等到早上；去东京时系统从日历自动调整。

## 实现

### Quiet Hours Gate

任何发送通知的 cron job 都必须先检查 quiet hours。

~~~
QUIET_START = 23
QUIET_END = 8

is_quiet(local_hour):
  return local_hour >= QUIET_START OR local_hour < QUIET_END
~~~

发送通知前：确定当前时区，转换 UTC 到本地时间；如果是 quiet hours，则 hold，不发送。

### Held Messages

~~~
if is_quiet():
  mkdir -p /tmp/cron-held/
  write("/tmp/cron-held/{job-name}.md", output)
  exit
else:
  send(output)
~~~

morning briefing 会读取 `/tmp/cron-held/*.md`，加入 “Overnight Updates”，然后删除文件。

### Timezone Awareness

agent 应把当前 timezone 存入 operational state，并在日历显示航班/酒店、用户提到新城市、活跃时间明显偏移时更新。展示给用户的时间一律使用用户本地时区。

### Shell Implementation

~~~bash
#!/bin/bash
TIMEZONE="${USER_TIMEZONE:-US/Pacific}"
LOCAL_HOUR=$(TZ="$TIMEZONE" date +%H)
if [ "$LOCAL_HOUR" -ge 23 ] || [ "$LOCAL_HOUR" -lt 8 ]; then
  echo "QUIET_HOURS=true"
  exit 1
fi
echo "QUIET_HOURS=false"
exit 0
~~~

### Configurable Hours

~~~json
{
  "quiet_hours": { "start": 23, "end": 8, "enabled": true }
}
~~~

## 容易踩坑的地方

1. **每个 job 都要 gate。** 漏一个就可能凌晨打扰用户。
2. **held messages 必须被捡起。** morning briefing 不读 `/tmp/cron-held/` 就会静默丢信息。
3. **时区自动检测很脆。** 日历没有旅行信息时，要用活跃时间推断并必要时询问用户。

## 如何验证

1. 把 quiet hours 设为当前小时，触发 cron，输出应进 `/tmp/cron-held/`。
2. 运行 morning briefing，确认 held message 出现并被删除。
3. 改成当前处于 quiet hours 的时区，通知应被 hold；改回活跃时区后应发送。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
