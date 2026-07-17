# Brain vs Memory vs Session

## 目标
知道什么进 VoltMind、什么进 agent memory、什么只留在 session context，让信息落在正确层级。

## 用户得到什么
没有它：人物档案进 agent memory 后重置即丢，用户偏好进 VoltMind 后污染知识页，agent 反复问已知问题。有了它：世界知识在 brain 中持久化，操作状态在 agent memory 中持久化，当前任务留在 session 中。

## 实现

~~~
on new_information(info):
    # Three layers, three purposes -- route to the right one

    if info.is_about_the_world:
        # VOLTMIND: people, companies, deals, meetings, concepts, ideas
        # This is world knowledge -- facts about entities external to the agent
        voltmind put <slug> --content "..."
        # Examples:
        #   "Pedro is CEO of Brex"           -> voltmind (person page)
        #   "Brex raised Series D at $12B"   -> voltmind (company page)
        #   "Tuesday's meeting covered Q2"   -> voltmind (meeting page)
        #   "The meatsuit maintenance tax"   -> voltmind (originals page)

    elif info.is_about_operations:
        # AGENT MEMORY: preferences, decisions, tool config, session continuity
        # This is how the agent operates -- not facts about the world
        memory_write(info)

    elif info.is_current_conversation:
        # SESSION CONTEXT: what was just said, current task, immediate state
        # No storage action needed
        pass

on user_asks(question):
    if question.about_person or question.about_company or question.about_meeting:
        voltmind search "{entity}"
        voltmind get <slug>
    elif question.about_preference or question.about_how_to_operate:
        memory_search("{topic}")
    elif question.about_current_context:
        pass
~~~

## 容易踩坑的地方

1. **不要把人物存进 agent memory。** “Pedro prefers email over Slack” 是关于 Pedro 的事实，应进入 Pedro 的 VoltMind 页面。
2. **不要把用户偏好存进 VoltMind。** “User likes bullet points” 是 agent 行为偏好，属于 agent memory。
3. **外部想法的用户综合进 VoltMind。** 用户对某个框架的原创理解放在 `originals/`。
4. **agent memory 在某些平台不能跨重置。** 关键世界知识必须在 VoltMind。
5. **拿不准就问：这是世界事实，还是操作方式？** 世界 -> VoltMind；操作 -> memory；当前对话 -> session。

## 如何验证

1. “Who is Pedro?” 应触发 `voltmind search` 或 `voltmind get`。
2. “How should I format responses?” 应查 agent memory。
3. `memory_search "person"` 不应返回人物档案。
4. `voltmind search "user prefers"` 不应返回偏好配置。
5. agent 重置后，`voltmind get <any_slug>` 仍应可用。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
