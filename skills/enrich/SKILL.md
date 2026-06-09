---
name: enrich
version: 2.0.0
description: |
  Enrich VoltMind person/company pages from local brain context plus
  user-approved evidence. Writes cited page updates, timeline entries,
  explicit graph links, and raw provenance payloads.
triggers:
  - "enrich"
  - "create person page"
  - "update company page"
  - "who is this person"
  - "look up this company"
tools:
  - get_page
  - put_page
  - search
  - query
  - list_pages
  - put_raw_data
  - get_raw_data
  - add_link
  - add_timeline_entry
  - get_backlinks
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
---

# Enrich Skill

Enrich person and company pages inside the VoltMind MVP boundary. Start from
local VoltMind context, then use external sources only when the user explicitly
requests or approves them.

## Contract

This skill guarantees:

- Existing VoltMind context is checked before new research.
- New facts are written with inline `[Source: ...]` citations.
- Raw evidence is preserved with `put_raw_data` when it comes from an API,
  website, export, or user-provided source payload.
- Dated evidence is added with `add_timeline_entry`.
- Durable relationships are materialized with `add_link` / `voltmind link`.
- New pages pass the notability and filing rules in
  `skills/_brain-filing-rules.md`.

## MVP Boundary

Allowed:

- Read/write VoltMind pages.
- Search/query local VoltMind context.
- Store and retrieve raw enrichment evidence.
- Add explicit graph links and timeline entries.
- Use user-approved external lookup as evidence, then cite it.

Frozen:

- Autonomous enrichment loops.
- Background person/company enrichment from every mention.
- Hidden inherited scorecards, salience, trajectory, founder, or expert flows.
- Unapproved scraping, social lookup, or paid API calls.

## Enrichment Tiers

| Tier | Who | Effort | Sources |
|------|-----|--------|---------|
| 1 | Close collaborators, key contacts, high-value companies | Full local review plus approved external evidence | VoltMind, user-provided evidence, approved web/API lookup |
| 2 | Notable but not central entities | Moderate | VoltMind, user-provided evidence, light approved lookup |
| 3 | Minor but useful entities | Minimal | VoltMind context and direct user evidence |

## Flow

1. Identify the entity and likely slug, such as `people/alice-example` or
   `companies/acme-example`.
2. Run `voltmind search "name"` and `voltmind query "what do we know about name"`.
3. Read the existing page with `voltmind get <slug>` when present.
4. Apply the notability gate before creating a new page.
5. Preserve raw evidence with `put_raw_data` when there is source payload worth
   auditing later.
6. Write or update the page with `put_page` / `voltmind put`.
7. Add dated evidence with `add_timeline_entry` / `voltmind timeline-add`.
8. Add durable relationships with `add_link` / `voltmind link`.
9. Verify incoming context with `get_backlinks` / `voltmind backlinks`.

## Page Shape

Person pages should usually include:

- `State`
- `Relationship`
- `What They Believe`
- `What They're Building`
- `Open Threads`
- `Timeline`

Company pages should usually include:

- `State`
- `Key People`
- `Open Threads`
- `Projects / Deals`
- `Timeline`

Leave unknown sections as brief gaps such as `[No data yet]`; do not invent
facts or create boilerplate stubs.

## Raw Evidence

Use `put_raw_data` for API responses, verified web snippets, user-provided
exports, or source payloads that support the enrichment:

```bash
voltmind call put_raw_data '{"slug":"people/alice-example","source":"user-provided-linkedin-export","data":{"fetched_at":"2026-06-09T00:00:00Z","summary":"..."}}'
```

Retrieve it when reviewing or debugging citations:

```bash
voltmind call get_raw_data '{"slug":"people/alice-example"}'
```

## Anti-Patterns

- Creating stub pages with no meaningful evidence.
- Enriching without checking VoltMind first.
- Overwriting the user's direct assessment with generic API text.
- Calling inherited `gbrain` commands or hidden advanced analysis flows.
- Running unapproved external research or scraping.

## Output Format

```text
ENRICHMENT REPORT
Entity: <name>
Slug: <slug>
Action: created / updated / skipped
Evidence used: <VoltMind pages, raw data sources, user-approved external sources>
Timeline entries: N
Graph links: N
Remaining gaps: <unknowns or review needs>
```

## Tools Used

- Search local context (`search`, CLI: `voltmind search`)
- Ask semantic questions (`query`, CLI: `voltmind query`)
- Read a VoltMind page (`get_page`, CLI: `voltmind get`)
- Store/update a VoltMind page (`put_page`, CLI: `voltmind put`)
- List pages by type/tag/recency (`list_pages`, CLI: `voltmind list`)
- Store raw enrichment evidence (`put_raw_data`, CLI: `voltmind call put_raw_data '{"slug":"...","source":"...","data":{...}}'`)
- Retrieve raw enrichment evidence (`get_raw_data`, CLI: `voltmind call get_raw_data '{"slug":"..."}'`)
- Link entities (`add_link`, CLI: `voltmind link`)
- Add dated evidence (`add_timeline_entry`, CLI: `voltmind timeline-add`)
- Check incoming context (`get_backlinks`, CLI: `voltmind backlinks`)
