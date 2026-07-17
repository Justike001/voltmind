# Entity Detection：每条消息都运行

## 目标
每条入站消息都扫描原创思考和实体提及，让 brain 在每次对话中自动成长。

## 用户得到什么
没有它：agent 会回答问题但忘掉一切。有了它：每个被提到的人、公司和想法都会形成或更新 brain 页面，下次再出现时已有上下文。

## 实现

每条消息都启动轻量 sub-agent。不要等它完成再回复；它并行运行。

~~~
on_every_message(message_text, source_context):
  spawn_subagent({
    model: "sonnet-class",
    timeout: 120,
    task: build_detection_prompt(message_text, source_context)
  })
~~~

### Detection Prompt

~~~
build_detection_prompt(text, source):
  return "SIGNAL DETECTION — scan this message for ideas AND entities..."
~~~

### Notability Filtering

~~~
is_notable(entity):
  // CREATE pages for specific, meaningful people/companies/media
  // DON'T create pages for generic passing references
~~~

### 什么算原创思考

| 捕获 | 不捕获 |
|---------|---------------|
| 关于世界如何运转的原创观察 | “ok”、“do it”、“sure” |
| 跨领域的新连接 | 没有观察的纯问题 |
| 框架和 mental models | 复述 agent 的话 |
| 模式识别 | 普通确认和反应 |
| 带理由的 hot takes | 日常操作消息 |

### Filing Rules

| Signal | Destination |
|--------|-------------|
| User generated the idea | `brain/originals/{slug}.md` |
| User's synthesis of others' ideas | `brain/originals/` |
| World concept someone else coined | `brain/concepts/{slug}.md` |
| Product or business idea | `brain/ideas/{slug}.md` |
| Person mentioned | `brain/people/{slug}.md` |
| Company mentioned | `brain/companies/{slug}.md` |
| Media referenced | `brain/media/{type}/{slug}.md` |

### Back-Linking 铁律

每次实体提及都必须从实体页反向链接到来源。没有 back-link，就无法遍历图。

## 容易踩坑的地方

1. **不要阻塞对话。** entity detection 异步运行。
2. **用 Sonnet，不用 Opus。** 这是模式匹配，不是深推理。
3. **原话很重要。** “Markdown is actually code” 比概括更有价值。
4. **不要创建 stub。** 要建页就完整 enrich。
5. **创建前先 dedup。** 名字变体和缩写会制造重复页。

## 如何验证

1. 提到一个人和公司，确认对应页面创建或更新。
2. 说一句原创想法，确认 `brain/originals/{slug}.md` 使用原话。
3. 检查实体页有回链。
4. 发送 “ok sounds good” 不应创建页面。
5. “Pedro” 和 “Pedro Franceschi” 应是同一页。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
