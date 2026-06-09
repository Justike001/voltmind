# VoltMind Personal Brain Schema

This schema is the local Phase 0/1 Personal Brain contract. Markdown remains the truth surface; PGLite indexes pages, links, tags, timelines, search state, and generated state pages.

## Core Frontmatter

Every page should carry these fields unless a narrower template says otherwise:

```yaml
scope: private
visibility: private
sensitivity: internal
promotion: ask_each_time
publish_level: never
source_refs: []
related_entities: []
owner: people/owner-slug
status: active
```

Allowed `publish_level` values are defined in `.system/policy-config.json` under `publish_levels`.

## Personal Brain Boundaries

- `private/` and raw `daily/` content must never be published directly.
- `meetings/` and `daily/` may create reviewed `contribution/candidates/`.
- `state/actions/`, `state/commitments/`, `state/decisions/`, and `state/risks/` are operational objects derived from primary pages.
- Phase 1 does not upload to Team Brain or Company Brain.

## Graph Materialization

Agents should preserve relationships through `source_refs`, `related_entities`, wiki links, and timeline entries. The runtime indexes these into PGLite for search, graph traversal, backlinks, and brief generation.
