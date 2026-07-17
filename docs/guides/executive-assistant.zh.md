# Executive Assistant 模式

## 目标
用 brain 上下文驱动邮件分诊、会议准备和排期，让每次互动都带着完整关系历史。

## 用户得到什么
没有它：agent 机械地说 “you have 12 unread”，会议准备只有 LinkedIn 简介，排期没有关系上下文。有了它：agent 在读邮件前知道发件人是谁，在每场会前给出共同历史，并根据关系温度和 open threads 做排期提醒。

## 实现

~~~
on email_batch(emails):
    for email in emails:
        sender_page = voltmind search "{email.sender_name}"
        if sender_page: context = voltmind get <sender_slug>

on upcoming_meeting(meeting):
    for attendee in meeting.attendees:
        results = voltmind search "{attendee.name}"
        if results: briefing[attendee] = voltmind get <attendee_slug>

on inbox_cleared():
    for email in processed_emails:
        if email.contained_new_information:
            voltmind add_timeline_entry <sender_slug> --entry "..." --source "..."
~~~

## 容易踩坑的地方

1. **先搜发件人，再读邮件。** brain context 会让分诊变成有上下文的判断。
2. **没有 brain 页的陌生发件人大多是噪声。** 除非内容强烈表明重要。
3. **会议准备是最高杠杆 EA workflow。** 用户进会前应知道 last interaction、open threads、关系历史。
4. **清 inbox 后更新 brain 才会复利。** 每封邮件都是信号。
5. **排期提醒需要 timeline 数据。** 会议摄取必须做好 entity propagation。

## 如何验证

1. 明天会议准备应为每个 attendee 先查 brain。
2. 分诊 5 封邮件，确认每个发件人都先被搜索。
3. 清 inbox 后检查发件人页面 timeline。
4. 排期建议应引用 attendee 的 brain 页面。
5. 已知联系人来信时，分诊应引用关系上下文。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
