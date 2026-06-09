---
name: capture
version: 2.0.0
description: Save a thought, snippet, or small text item into VoltMind through the MVP capture path.
triggers:
  - "capture this"
  - "save this thought"
  - "remember this"
  - "ingest this into my brain"
  - "drop this in the inbox"
  - "save to brain"
writes_pages:
  - "inbox/*"
---

# Capture — VoltMind MVP

Use `voltmind capture` when the user wants to save a thought, pasted text,
article excerpt, meeting note, or small local note into the knowledge base.

## Contract

- Input: inline text, `--file PATH`, or `--stdin`.
- Output: a saved page in the local PGLite-backed VoltMind runtime.
- Side effect: the content is immediately available to `voltmind search` and
  `voltmind query`; embeddings may be refreshed with `voltmind embed --stale`.
- Trust: capture through this skill is a local CLI action.

## How To Use

```bash
voltmind capture "the thought I want to remember"
voltmind capture --file ./notes/today.md
echo "from a pipe" | voltmind capture --stdin
voltmind capture "..." --slug inbox/2026-05-29-example
voltmind capture "..." --type idea --source user
voltmind capture "..." --quiet
voltmind capture "..." --json
```

## Defaults

- Slug: inbox-style slug chosen by the runtime unless `--slug` is provided.
- Type: `note` unless overridden.
- Source: keep explicit source/provenance whenever the user gives it.

## When Not To Use

- Bulk local markdown import: use `voltmind import`.
- Re-indexing an existing source: use `voltmind sync`.
- Embedding refresh: use `voltmind embed --stale`.
- Advanced media, transcript, book, publish, or enrichment pipelines: frozen for
  MVP. Capture the text only, or tell the user the specialized pipeline is not
  included yet.

## Anti-Patterns

- Calling `gbrain`.
- Routing to media/meeting/social ingestion skills during MVP.
- Passing secrets as inline command arguments. Use `--file` or `--stdin`.

