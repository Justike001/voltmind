---
name: brain-ops
version: 2.0.0
description: |
  VoltMind MVP knowledge-base operations. The core read/write loop: brain-first
  lookup, source-aware page CRUD, citations, auto-link context, and basic graph
  retrieval.
triggers:
  - any VoltMind read/write/lookup/citation
  - "build the graph"
  - "link these entities"
  - "create relationship"
  - "connect pages"
  - "整理实体关系"
  - "建链"
  - "where should this page go"
  - "filing rules"
  - "source selection"
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
writes_to:
  - people/
  - companies/
  - concepts/
  - projects/
  - meetings/
  - analysis/
---

# Brain Operations — VoltMind MVP

VoltMind is currently a local-first knowledge-base runtime backed by PGLite. This
skill is the always-on behavior layer for MVP-safe brain reads and writes.

## Boundary

Follow the central MVP boundary in `AGENTS.md` and `skills/RESOLVER.md`.
This skill adds the always-on read/write discipline for the allowed page,
retrieval, graph, timeline, source, and sync commands.

## Contract

This skill guarantees:

- Check VoltMind before external lookup when answering about known entities or
  prior notes.
- Ground claims in page slugs, source ids, or explicit gap statements.
- Preserve user-provided facts with citations such as `[Source: User, YYYY-MM-DD]`.
- Use Page CRUD and capture/import paths that are public in the MVP.
- Materialize entity relationships into the graph through automatic link
  reconciliation and explicit typed links.

## Iron Law: Back-Linking (MANDATORY)

Every mention of a person or company with a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them. An unlinked mention is a
broken brain. See `skills/conventions/quality.md` for format.

### Phase 1: Brain-First Lookup (MANDATORY)

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

### Phase 2: On Every Inbound Signal (READ → ENRICH → WRITE)

Every message, meeting, email, or conversation that references a person or company:

1. **Detect entities** — people, companies, deals mentioned
2. **Load brain pages** — read existing pages for context before responding
3. **Identify new information** — what does this signal tell us that the page doesn't know?
4. **Write it back** — update the brain page with new info + timeline entry + source citation
5. **Create if missing** — if notable and no page exists, create via enrich skill

**User's direct statements are the highest-value data source.** Write them to brain
pages immediately with attribution `[Source: User, YYYY-MM-DD]`.

### Phase 2.5: Structured Graph Updates (automatic)

Every `put_page` call automatically extracts entity references and writes them
to the graph (`links` table) with inferred relationship types. Stale links
(refs no longer in the page text) are removed in the same call. This is
"auto-link" reconciliation.

- No manual `add_link` calls needed for ordinary page writes.
- Inferred link types: `attended` (meeting -> person), `works_at`, `invested_in`,
  `founded`, `advises`, `source` (frontmatter), `mentions` (default).
- The `put_page` MCP response includes `auto_links: { created, removed, errors }`
  so the agent can verify outcomes.
- To disable: `voltmind config set auto_link false`. Default is on.
- Timeline entries with specific dates still need explicit `voltmind timeline-add`
  (or batch via `voltmind extract timeline --source db`).

### Phase 3: On Every Outbound Response (READ → PULL → RESPOND)

Before answering any question about a person, company, or topic:

1. **Check the brain** — read relevant pages
2. **Pull context** — use compiled truth + recent timeline
3. **Respond with context** — the brain makes every answer better

Don't answer from general knowledge when a brain page exists.

### Phase 4: Ambient Enrichment

This is not a special mode. This is the default. Everything the user says is an
ingest event.

- Person mentioned → check brain, create/enrich if needed (spawn background)
- Company mentioned → same
- Link shared → ingest it (delegate to idea-ingest)
- Data shared → delegate to appropriate skill

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

Every write should include enough provenance for later retrieval. Source-backed
signals may automatically create or update person/company pages through the MVP
signal-enrichment hook. Unsourced, low-confidence, or non-notable mentions must
not create pages.

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
- Running autonomous enrichment loops, dream, autopilot, social/web crawlers, or
  schema-author workflows. Source-backed MVP signal enrichment is allowed.
- Switching storage/topology away from local PGLite during MVP unless the user is
  explicitly designing a future phase.
- Leaving curated entity relationships only in prose when they should be graph
  edges.

  ## Tools Used

- `search` — keyword search
- `query` — hybrid vector+keyword search
- `get_page` — read a brain page
- `put_page` — create/update brain pages
- `add_link` — cross-reference entities
- `add_timeline_entry` — record events
- `get_backlinks` — check who references an entity
- `sync_brain` — sync changes to the index
