# 内容和媒体摄取

## 目标
YouTube 视频、社交媒体、PDF 和文档会变成可搜索的 brain 页面，带有 agent 自己的分析，并完整交叉引用到每个被提到的实体。

## 用户得到什么
没有它：媒体链接只是会腐烂的书签。有了它：每份媒体都是永久 brain 页面，叠加 agent 分析，所有被提到的实体都有反向链接，完整内容长期可搜索。

## 实现

~~~
on user_shares_media(url_or_file):

    # PATTERN 1: YouTube Video Ingestion
    if media.type == "youtube":
        transcript = diarize(video_url)  # speaker-attributed transcript
        analysis = agent_analyze(transcript, user_context)
        slug = f"media/youtube/{video_slug}"
        voltmind put <slug> --content """
            # {title}
            **Channel:** {channel} | **Date:** {date} | **Link:** {url}

            ## Analysis
            {agent_analysis}

            ## Key Quotes
            - **{Speaker}** ({timestamp}): "{quote}" -- {why_it_matters}

            ---
            ## Full Transcript
            {diarized_transcript}
        """
        for person in transcript.mentioned_people:
            voltmind add_link <slug> <person_slug>
            voltmind add_link <person_slug> <slug>

    elif media.type == "tweet" or media.type == "social":
        bundle = { "original": fetch_tweet(url), "thread": reconstruct_thread(url) }
        slug = f"media/social/{platform}-{author}-{date}"
        voltmind put <slug> --content "..."

    elif media.type == "pdf" or media.type == "document":
        content = ocr_if_needed(file) or extract_text(file)
        slug = f"sources/{document_slug}"
        voltmind put <slug> --content "..."

    voltmind sync
~~~

## 容易踩坑的地方

1. **永远要完整 transcript，不要 AI summary。** 摘要会丢掉谁说了什么、措辞、语气和未说出口的东西。
2. **价值在 agent 自己的分析。** 不是复述，而是把媒体连接到用户世界观和已有 brain。
3. **社交媒体是 bundle。** tweet、thread、quoted tweets、链接文章和 engagement context 要一起重建。
4. **交叉引用让媒体页面活起来。** 每个被提到的实体都要有 link 和 timeline 条目。
5. **`media/` 会变成可搜索档案。** 视频、播客、采访、文章、tweet 都会带着评论长期保存。

## 如何验证

1. 摄取 YouTube 后，`voltmind get media/youtube/{slug}` 应包含 agent 分析、key quotes 和完整 transcript。
2. `voltmind get_links media/youtube/{slug}` 应有被提到实体的反向链接。
3. 人物页 timeline 应新增引用视频的条目。
4. tweet 页面应包含 thread、链接文章摘要和实体引用。
5. `voltmind search "{topic_from_video}"` 应能搜到媒体页。

---
*属于 [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md)。*
