---
name: ingest
version: 2.0.0
description: MVP ingestion for local markdown/text: capture, import, sync, embed.
triggers:
  - "ingest this"
  - "save this to brain"
  - "import this folder"
  - "sync this source"
  - "embed stale chunks"
tools:
  - search
  - get_page
  - put_page
  - sync_brain
mutating: true
writes_pages: true
writes_to:
  - sources/
  - voice-notes/
  - conversations/
  - media/
  - concepts/
  - ideas/
---

# Ingest Skill — VoltMind MVP

VoltMind Phase 2 ingestion is deliberately small: local text/markdown capture,
folder import, source sync, chunking, and embedding refresh.

## MVP Boundary

Allowed:

- `voltmind capture` for one item.
- `voltmind import <path>` for local markdown/text folders.
- `voltmind sync` for registered local sources.
- `voltmind embed --stale` for stale chunks.
- `voltmind search` / `voltmind query` to verify retrieval.
- `voltmind link` / `voltmind timeline-add` for agent-curated relationships
  discovered during page整理.

Frozen:

- Media/PDF/video/podcast/book pipelines.
- Meeting transcript enrichment.
- Social/web article enrichment.
- Raw cloud file storage and large binary migration.
- Automatic person/company enrichment and autonomous background loops.

## Flow

1. Identify whether the input is a single item or a local folder/source.
2. For a single thought or pasted text, use `voltmind capture`.
3. For a local markdown/text directory, use `voltmind import <path> --no-embed`
   when you want a fast import, then `voltmind embed --stale`.
4. For an existing registered source, run `voltmind sync --no-pull --no-embed`,
   then `voltmind embed --stale`.
5. For curated entity pages, add explicit typed links for known relationships
   that auto-link cannot infer reliably.
6. Verify with `voltmind search "<known term>"` or
   `voltmind query "<known question>"`.

## Relationship Materialization

If ingestion produces a cleaned page plus entity relationships, store both:

```bash
voltmind put projects/voltmind-runtime
voltmind link projects/voltmind-runtime concepts/local-first-memory --type mentions
voltmind link projects/voltmind-runtime people/alice --type discussed
voltmind timeline-add projects/voltmind-runtime 2026-05-29 "MVP graph boundary reviewed [Source: user]"
```

Then verify:

```bash
voltmind graph projects/voltmind-runtime --depth 2
```

## Citation And Filing

Write provenance into page content when the user provides it. Use
`skills/_brain-filing-rules.md` for page placement, but keep the runtime path on
MVP commands only.

## Output Format

```text
INGESTED: <title or path>
Pages imported/captured: N
Embeddings: refreshed / pending
Graph links: N
Verification: <search/query result or gap>
Frozen items: <anything requested but outside MVP>
```

## Anti-Patterns

- Calling hidden inherited import/enrichment commands.
- Promising raw media analysis or cloud storage migration.
- Bulk looping `voltmind capture` when `voltmind import` fits.
- Skipping retrieval verification after import.
