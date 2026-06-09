# Brain Filing Rules — VoltMind MVP

These rules apply to MVP skills that write pages into VoltMind.

## The Rule

The primary subject determines where a page goes. Not the format, not the
source, and not the skill that is running.

## Decision Protocol

1. Identify the primary subject: person, company, project, concept, meeting, or
   raw/captured note.
2. File in the directory that matches that subject.
3. Add citations and graph links to related pages when relationships are durable.
4. When unsure, use `inbox/` or ask the user rather than inventing a taxonomy.

## MVP Directories

| Directory | Use |
|-----------|-----|
| `inbox/` | one-off captures and untriaged notes |
| `people/` | people the user expects to reference again |
| `companies/` | companies relevant to the user's work or notes |
| `projects/` | projects, products, workstreams |
| `concepts/` | reusable ideas, frameworks, technical concepts |
| `meetings/` | meeting notes or dated discussion records |
| `sources/` | raw imported source snapshots that feed multiple pages |

## Common Misfiling Patterns

| Wrong | Right | Why |
|-------|-------|-----|
| Analysis of a topic in `sources/` | `concepts/` or project directory | `sources/` is for raw/source material |
| Article about a person in `sources/` | `people/` if the person is primary | Primary subject is the person |
| Meeting-derived company info only in `meetings/` | meeting page plus company link/update | Retrieval should find company context |
| Original framework in `sources/` | `concepts/` | It is reusable knowledge |
| Unclear pasted text forced into a taxonomy | `inbox/` | MVP should avoid premature structure |

## Notability Gate

Before creating a new entity page:

- People: Will the user likely interact with or ask about them again?
- Companies: Are they relevant to the user's work, projects, or research?
- Projects: Is this a durable workstream?
- Concepts: Is this a reusable model or term?

When in doubt, do not create a new entity page. Capture to `inbox/` and let the
user or later curation promote it.

## Back-Linking

Every mention of a person or company with an existing VoltMind page should link
back to that page when the relationship is meaningful. Ordinary `voltmind put`
calls reconcile basic links automatically, so manual link work should be rare.

Format for manual context when needed:

```text
- **YYYY-MM-DD** | Referenced in [page title](path/to/page.md) -- brief context
```

For agent-curated relationships that are known but not inferable from prose, add
typed links explicitly:

```bash
voltmind link <from-slug> <to-slug> --type mentions
voltmind link people/alice companies/acme --type works_at
voltmind link meetings/2026-05-29-sync people/alice --type attended
```

This is MVP scope. Broad historical graph backfill is frozen, but per-page
relationship materialization is not.

## Citation Requirements

Every fact written to a page should carry source context.

- Direct attribution: `[Source: User, YYYY-MM-DD]`
- Imported/local file: `[Source: <file or source id>, YYYY-MM-DD]`
- Web/user-provided URL: `[Source: <publication or URL>, YYYY-MM-DD]`
- Synthesis: `[Source: compiled from <sources>]`

Source precedence:

1. User's direct statements.
2. Existing VoltMind pages.
3. Timeline entries.
4. Imported/captured source excerpts.
5. External sources.

## Frozen For MVP

Do not use raw cloud file storage, large media routing, dream-cycle synthesize
directories, takes/facts fences, schema-author routes, or publishing/export
rules in MVP agent routing. If the user asks for one, capture the text or explain
that the specialized pipeline is frozen.
