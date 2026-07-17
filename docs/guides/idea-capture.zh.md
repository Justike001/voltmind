# Idea Capture：Originals、深度与分发

## 目标
用原话、深上下文和交叉链接捕获用户原创思考，让 originals folder 成为 brain 中最高价值的内容。

## 用户得到什么
没有它：对话中的好想法会消失。有了它：每个原创观察都被逐字捕获，链接到塑造它的人和材料，并评估发布潜力。

## 实现

~~~
capture_idea(message_text, source_context):
  if user_generated_the_idea(message_text): destination = "brain/originals/{slug}.md"
  elif user_synthesis_of_others(message_text): destination = "brain/originals/{slug}.md"
  elif world_concept(message_text): destination = "brain/concepts/{slug}.md"
  elif product_or_business_idea(message_text): destination = "brain/ideas/{slug}.md"
  page = create_or_update(destination, { content: message_text, source: source_context })
  link_to_people(page, mentioned_people)
  link_to_companies(page, mentioned_companies)
  voltmind sync --no-pull --no-embed
~~~

### The Authorship Test

| Signal | Destination |
|--------|-------------|
| User generated the idea | `brain/originals/{slug}.md` |
| User's unique synthesis of others' ideas | `brain/originals/` |
| World concept someone else coined | `brain/concepts/{slug}.md` |
| Product or business idea | `brain/ideas/{slug}.md` |
| User's ghostwritten book/essay | `brain/originals/` |
| Article ABOUT user | `brain/media/writings/` |

### 捕获标准

**使用用户原话。** 语言本身就是 insight。不要润色、概括或企业化。

### 深度测试

陌生人读这个页面时，是否能理解用户不仅在想什么，还能理解为什么这样想、如何走到这里？如果不能，就补 reasoning path、influences、context 和情绪/心理细节。

### Originality Distribution Rating

~~~markdown
## Originality Distribution

- **General population:** 72/100 — most people haven't encountered this framework
- **Tech industry:** 45/100 — common in startup circles but novel to most

**Publish signal:** Strong essay candidate. Best audience: founders, builders.
~~~

### Deep Cross-Linking Mandate

original 必须链接到塑造它的人、公司、会议、书和媒体、其他 originals、以及它挑战或建立在其上的 concepts。

## 容易踩坑的地方

1. **Synthesis IS original。** 新组合本身就是 insight。
2. **原话不可协商。** 不要 paraphrase。
3. **cross-links 是强制的。** 没有连接的 original 是死笔记。

## 如何验证

1. 说一句原创想法，确认 `brain/originals/{slug}.md` 用原话创建。
2. 检查至少有相关人物或概念链接，并有回链。
3. 陌生人读页面应能理解 WHY，而不只是 WHAT。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
