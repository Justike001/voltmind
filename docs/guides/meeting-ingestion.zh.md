# 会议摄取

## 目标
会议 transcript 会变成 brain 页面，并在一次处理中更新所有被提到的实体：参会者、公司、deal 和 action items。

## 用户得到什么
没有它：会议消失在记忆里，action items 被遗忘，agent 不知道上次和某人聊了什么。有了它：每场会议都是永久记录，并 enrich 触及的每个人和公司页面。

## 实现

~~~
on new_meeting_transcript(meeting):
    transcript = fetch_full_transcript(meeting.id)  # e.g., Circleback API
    slug = f"meetings/{meeting.date}-{short_description}"
    compiled_truth = agent_analysis(transcript)
    timeline = format_diarized_transcript(transcript)
    voltmind put <slug> --content "<compiled_truth>
---
<timeline>"

    for person in meeting.attendees + meeting.mentioned_people:
        voltmind add_timeline_entry <person_slug> --entry "..." --source "..."
    for company in meeting.mentioned_companies:
        voltmind add_timeline_entry <company_slug> --entry "..." --source "..."
    action_items = extract_action_items(transcript)
    for entity in all_entities_mentioned:
        voltmind add_link <slug> <entity_slug>
        voltmind add_link <entity_slug> <slug>
    voltmind sync
~~~

## 容易踩坑的地方

1. **永远拉完整 transcript，不要 AI summary。** summary 会编造 framing。
2. **entity propagation 是最容易被跳过的一步。** 会议页本身不够，每个相关实体页都要更新。
3. **被提到的人不只是参会者。** 会中讨论 Sarah，也要更新 Sarah 和她公司的页面。
4. **agent 分析才是价值。** 要指出惊讶、矛盾、真正决定和未解决点。
5. **back-links 必须双向。** meeting -> entity，entity -> meeting。

## 如何验证

1. `voltmind get meetings/{date}-{slug}` 应有上方分析和下方完整 transcript。
2. 每个 attendee 页面 timeline 应有具体会议洞察。
3. 被提到公司页面应有相关条目。
4. `voltmind get_links meetings/{date}-{slug}` 应包含所有实体。
5. `voltmind search "{meeting_topic}"` 应搜到会议页。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
