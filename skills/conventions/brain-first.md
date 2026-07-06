# Brain-First Lookup Convention — VoltMind MVP

Read this before doing any entity, project, concept, note, or fact lookup.

## Available VoltMind Tools

Tool names vary by transport. CLI commands use `voltmind`; MCP tools usually
use short operation names.

| Tool | Use for |
|------|---------|
| `search` / `voltmind search` | Keyword search; fast and works before embeddings are complete |
| `query` / `voltmind query` | Hybrid keyword + semantic retrieval |
| `get_page` / `voltmind get` | Full page read when a slug is known |
| `list_pages` / `voltmind list` | Page discovery by filters |
| `get_backlinks` / `voltmind backlinks` | Who references a page |
| `get_links` / `voltmind call get_links` | Outgoing links from a page |
| `get_timeline` / `voltmind timeline` | Dated page context |
| `traverse_graph` / `voltmind graph` | Basic graph traversal |
| `put_page` / `voltmind put` | Create or update a page |
| `add_link` / `voltmind link` | Add a typed relationship between pages |
| `add_timeline_entry` / `voltmind timeline-add` | Add dated evidence to a page |
| `sync_brain` / `voltmind sync` | Refresh index from local source files |

Do not use inherited `gbrain__` tool prefixes in new MVP guidance.

## Lookup Chain

1. `voltmind search "<keywords>"` first.
2. `voltmind query "<natural question>"` if keyword search is thin.
3. `voltmind get <slug>` if a result points to a relevant page.
4. Graph context only when needed: `links`, `backlinks`, `timeline`, `tags`,
   or `graph`.
5. External APIs only after VoltMind has no useful local context or the user
   explicitly asks for current web research.

Never skip local retrieval for a question that may already be represented in
VoltMind.

## Rules

- Use the local PGLite-backed VoltMind brain resolved by `VOLTMIND_HOME` or
  `~/.voltmind`.
- Respect source routing from `--source`, `VOLTMIND_SOURCE`, or
  `.voltmind-source`.
- After a page write backed by local files, run `voltmind sync --no-pull
  --no-embed`; run `voltmind embed --stale` when retrieval quality needs fresh
  vectors.
- Cite page slugs and source ids when available.
- Use memory tools for agent preferences/session state, not entity or page
  lookup.

## Entity Page Conventions

Common MVP directories:

| Directory | Type | Example |
|-----------|------|---------|
| `people/` | person | `people/alice-example.md` |
| `companies/` | company | `companies/acme-example.md` |
| `projects/` | project | `projects/voltmind.md` |
| `concepts/` | concept | `concepts/local-first-memory.md` |
| `meetings/` | meeting | `meetings/2026-05-29-runtime-sync.md` |
| `inbox/` | captured note | `inbox/2026-05-29-example.md` |

When creating pages, include enough frontmatter/content for retrieval and
provenance. Avoid creating junk entity pages just because a name appeared once.

## Frozen For MVP

Do not route lookup through cross-brain mounts, schema evolution, autonomous
subagents, dream cycles, or advanced eval/search-mode tools. The narrow
knowledge insight commands (`whoknows`, `salience`, `anomalies`, and
`calibration`) and retrieval-enrichment readouts (`transcripts`,
`find_contradictions`) are available in the MVP runtime when they match the
user's request. Write-mode extraction must be explicit and source-bound
(`--source-id`); use `--dry-run` for preview.
