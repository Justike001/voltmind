---
name: brain-ops
version: 2.0.0
description: |
  VoltMind MVP knowledge-base operations. The core read/write loop: brain-first
  lookup, source-aware page CRUD, citations, auto-link context, and basic graph
  retrieval.
triggers:
  - any VoltMind read/write/lookup/citation
tools:
  - search
  - query
  - get_page
  - put_page
  - list_pages
  - add_link
  - remove_link
  - get_links
  - get_backlinks
  - traverse_graph
  - add_timeline_entry
  - get_timeline
  - sync_brain
mutating: true
writes_pages: true
---

# Brain Operations — VoltMind MVP

VoltMind is currently a local-first knowledge-base runtime backed by PGLite. This
skill is the always-on behavior layer for MVP-safe brain reads and writes.

## MVP Boundary

Use `voltmind`, not `gbrain`. Use `VOLTMIND_HOME`, `VOLTMIND_SOURCE`,
`.voltmind-source`, and `voltmind.yml`. Do not use old `GBRAIN_*`, `.gbrain`,
or `gbrain.yml` paths.

Allowed runtime surface:

- `voltmind search`, `voltmind query`, `voltmind get`, `voltmind list`
- `voltmind put`, `voltmind delete`, `voltmind restore`
- `voltmind capture`, `voltmind import`, `voltmind sync`, `voltmind embed`
- `voltmind link`, `voltmind unlink`, `voltmind backlinks`,
  `voltmind tags`, `voltmind timeline`, `voltmind timeline-add`,
  `voltmind graph`
- MCP `get_links` through `voltmind call` when outgoing-link inspection is
  required
- `voltmind sources`, `voltmind status`, `voltmind doctor`

Frozen for MVP: ambient enrichment loops, autonomous agents, dream/autopilot,
schema evolution, skillpack publishing, cross-brain mounts, raw media storage,
advanced evaluation, and Minion submit/worker workflows.

## Contract

This skill guarantees:

- Check VoltMind before external lookup when answering about known entities or
  prior notes.
- Ground claims in page slugs, source ids, or explicit gap statements.
- Preserve user-provided facts with citations such as `[Source: User, YYYY-MM-DD]`.
- Use Page CRUD and capture/import paths that are public in the MVP.
- Materialize entity relationships into the graph through automatic link
  reconciliation and explicit typed links.

## Lookup Protocol

Before answering a question about a person, company, project, concept, or prior
note:

1. `voltmind search "name or keywords"` for fast keyword matches.
2. `voltmind query "natural question"` for hybrid search.
3. `voltmind get <slug>` when a specific page is relevant.
4. Use `voltmind backlinks <slug>`, `voltmind timeline <slug>`, or
   `voltmind graph <slug>` for relationship questions. Use MCP `get_links`
   through `voltmind call` only when outgoing edges are specifically required.

If VoltMind has no relevant page, say so plainly instead of filling gaps from
general knowledge.

## Write Protocol

For one-off thoughts or pasted content, prefer:

```bash
voltmind capture "content to remember"
```

For explicit page updates, use `voltmind put <slug>` or the MCP `put_page`
operation. After file-backed edits, keep the index current:

```bash
voltmind sync --no-pull --no-embed
voltmind embed --stale
```

Every write should include enough provenance for later retrieval. Do not silently
create person/company pages as a background enrichment task; in MVP, ask or use a
direct capture/page update.

## Entity Graph Write Protocol

Building a useful page graph is part of VoltMind MVP.

When an agent整理后的 page names durable entities or relationships:

1. Write the curated page with `voltmind put <slug>` or MCP `put_page`.
2. Let `put_page` auto-reconcile ordinary markdown/frontmatter links into the
   graph.
3. Add explicit typed links when the relationship is known but not safely
   inferable from text:

   ```bash
   voltmind link people/alice companies/acme --type works_at
   voltmind link meetings/2026-05-29-sync people/alice --type attended
   ```

4. Add dated evidence when the relationship is temporal:

   ```bash
   voltmind timeline-add people/alice 2026-05-29 "Joined the VoltMind runtime review [Source: meeting notes]"
   ```

5. Verify the graph:

   ```bash
   voltmind backlinks companies/acme
   voltmind graph people/alice --depth 2
   ```

Use explicit links for relationships that matter to retrieval, context assembly,
or "who/what connects to X" questions. Do not create links for incidental name
drops.

## Source-Aware Citations

Every page payload returned by search/query/get/list may include `source_id`.
When citing a page, include the source if available:

- Single source: `[default:concepts/example]`
- Named source: `[notes:projects/voltmind-runtime]`

The key is `sources.id`, not display name.

## Anti-Patterns

- Calling hidden inherited commands because they still exist in source files.
- Answering from general knowledge when VoltMind has matching pages.
- Writing facts without provenance.
- Running autonomous enrichment, dream, autopilot, or schema-author workflows.
- Switching storage/topology away from local PGLite during MVP unless the user is
  explicitly designing a future phase.
- Leaving curated entity relationships only in prose when they should be graph
  edges.
