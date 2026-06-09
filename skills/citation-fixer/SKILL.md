---
name: citation-fixer
version: 2.0.0
description: |
  Audit and fix citation formatting across VoltMind pages. Ensures claims
  carry traceable inline [Source: ...] citations and preserves unresolved
  gaps for human review.
triggers:
  - "fix citations"
  - "fix broken citations"
  - "citation audit"
  - "check citations"
  - "citation fixer"
tools:
  - search
  - get_page
  - put_page
  - list_pages
  - get_raw_data
mutating: true
---

# Citation Fixer Skill

Use this skill to audit and repair citation formatting in VoltMind pages. The
goal is traceability, not making uncited claims look sourced.

## Contract

This skill guarantees:

- Pages are scanned for inline `[Source: ...]` citations.
- Malformed citations are normalized to the project convention.
- Missing citations are flagged with page slug and nearby text.
- Raw provenance is checked with `get_raw_data` when available.
- Facts without evidence are not invented, deleted, or silently rewritten.

## Flow

1. Find target pages with `voltmind list`, `voltmind search`, or an explicit slug.
2. Read each page with `voltmind get <slug>`.
3. Identify:
   - facts without citations
   - citations missing source or date
   - malformed citation syntax
   - citations that refer to raw evidence not reflected in the page
4. Retrieve raw evidence with `get_raw_data` when the page has attached source
   payloads.
5. Patch only mechanical citation-format issues with `put_page`.
6. Report unresolved claims for user review.

## Optional External Resolution

If a citation references a web post, X/Twitter post, article, or API record but
the URL is missing, resolve it only when the user explicitly approves external
lookup or provides the source payload. Deterministic links are allowed; guessed
URLs are not.

## State

If a recurring batch needs progress tracking, store a small state page or raw
payload under VoltMind, for example:

- `state/indexes/citation-fixer-state`
- raw data source `citation-fixer-state`

Do not use old `~/.gbrain` paths.

## Output Format

```text
CITATION AUDIT REPORT
Pages scanned: N
Citations found: N
Issues fixed: N
Unresolved claims: N
Pages updated: <slugs>
Needs review: <slugs and reasons>
```

## Anti-Patterns

- Inventing citations for facts that have no source.
- Removing facts that lack citations without user approval.
- Fixing citations without reading the full page context.
- Batch-fixing without checking quality on a small sample first.
- Calling inherited `gbrain` commands or hidden citation pipelines.

## Tools Used

- Search for candidate pages (`search`, CLI: `voltmind search`)
- List candidate pages (`list_pages`, CLI: `voltmind list`)
- Read a VoltMind page (`get_page`, CLI: `voltmind get`)
- Store/update a VoltMind page (`put_page`, CLI: `voltmind put`)
- Retrieve raw provenance (`get_raw_data`, CLI: `voltmind call get_raw_data '{"slug":"..."}'`)
