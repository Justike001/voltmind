---
name: media-ingest
version: 1.0.0
description: |
  Ingest video, audio, PDF, book, screenshot, and GitHub repo content into the brain.
  Multi-format handling with entity extraction and backlink propagation. Covers
  video-ingest, youtube-ingest, and book-ingest subtypes.
triggers:
  - "watch this video"
  - "process this YouTube link"
  - "ingest this PDF"
  - "save this podcast"
  - "process this book"
  - "PDF book"
  - "summarize this book"
  - "ingest it into my brain"
  - "what's in this screenshot"
  - "check out this repo"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
mutating: true
writes_pages: true
writes_to:
  - concepts/
  - people/
  - companies/
  - sources/
---

# Media Ingest Skill

Ingest video, audio, PDF, book, screenshot, and GitHub repo content into the brain.

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

## Contract

This skill guarantees:
- Every ingested media item has a brain page with analysis (not just a transcript dump)
- Transcripts (video/audio) saved in raw and human-readable formats
- Entity extraction: every person and company mentioned gets back-linked
- Raw provenance preserved according to topology: Host-local uploads may use
  `voltmind files upload-raw`; thin clients persist an external file reference
  and never invoke the Host-only `file_upload` operation.
- Filing by primary subject, not by media format

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Every mention of a person or company with a brain page MUST create a back-link.

## Phases

### Phase 1: Identify format and fetch

| Format | Action |
|--------|--------|
| YouTube/video URL | Fetch transcript (Whisper, transcription service, or captions) |
| Audio file | Transcribe with available STT service |
| PDF | Extract text (OCR if needed) |
| Book PDF | Extract text, identify chapters/sections |
| Screenshot/image | OCR via vision model, extract text and entities |
| GitHub repo | Clone, read README + key files, summarize architecture |

### Phase 2: Preserve raw provenance (topology gate)

First determine whether the agent is running on the Host or as a thin client.

- **Host-local CLI only:** save the original file with
  `voltmind files upload-raw <file> --page <slug>`. `file_upload` is an admin,
  `localOnly` operation and is intentionally unavailable through remote MCP.
- **Thin client:** do not call `file_upload` and do not send a workstation path
  to the Host. Persist the provider's stable `ExternalFileReferenceV1` (service,
  tenant/drive/item ids, canonical URL, MIME type, availability, and occurrence
  identity) in the local evidence page. Write semantic Markdown through the
  local `voltmind put`/client-first writer so the local vault exists before MCP
  synchronization. Ask the Host operator to materialize bytes only when the
  user explicitly requests it.

See `skills/conventions/client-ingest-control-plane.md` for the complete
file-reference and local-write-ahead contract.

### Phase 3: Create brain page

File by primary subject (not format). Use this template:

```markdown
# {Title}

**Source:** {URL or file path}
**Format:** {video/audio/PDF/book/screenshot/repo}
**Created:** {date}

## Summary
{Key points, not a transcript dump}

## Key Segments / Highlights
{For video/audio: timestamped highlights. For books: chapter summaries.}

## People Mentioned
{List with links to brain pages}

## Companies Mentioned
{List with links to brain pages}
```

### Phase 4: Entity extraction and propagation

For every person and company mentioned:
1. Check brain for existing page
2. Create/enrich if needed (delegate to enrich skill)
3. Add back-link from entity page to this media page
4. Add timeline entry on entity page

A media item is NOT fully ingested until entity propagation is complete.

### Phase 5: Sync

`voltmind sync` to update the index.

## Output Format

Brain page created with summary, highlights, and entity cross-links. Report to user:
"Ingested {title}: {N} entities detected, {N} pages updated."

## Anti-Patterns

- Dumping raw transcripts without analysis
- Skipping entity extraction ("I'll do that separately")
- Filing **raw ingest** by format (all videos in `media/videos/`) instead of by subject. Note: format-prefixed paths under `media/<format>/<slug>` ARE sanctioned for **synthesized one-of-one output** like book-mirror's `media/books/<slug>-personalized.md`. The anti-pattern is for raw ingest, not for sui generis synthesis. See `skills/_brain-filing-rules.md` "Sanctioned exception: synthesis output is sui generis."
- Not preserving raw source files
- Calling `file_upload` or `voltmind files upload-raw` from a thin client
- Treating a client-local path as if the Host could open it; use an
  `ExternalFileReferenceV1` instead
- Creating stub pages without meaningful content
