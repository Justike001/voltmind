---
name: project
version: 1.0.0
description: Maintain project context, open threads, actions, commitments, risks, and timelines.
triggers:
  - "project update"
  - "update project page"
  - "project context"
  - "open threads"
  - "项目更新"
  - "项目上下文"
tools:
  - search
  - query
  - get_page
  - put_page
  - get_backlinks
  - get_timeline
mutating: true
writes_pages: true
writes_to:
  - projects/
  - state/actions/
  - state/decisions/
  - state/commitments/
  - state/risks/
---

# VoltMind Project Loop

Use this skill to maintain `projects/` as the coordination surface. Read the scaffold resolver, index, schema, and policy files first.

## Contract

This skill updates project context from approved evidence and links canonical state objects instead of duplicating them.

Project pages should link to canonical state pages rather than duplicating them:

- `state/actions/`
- `state/commitments/`
- `state/decisions/`
- `state/risks/`
- `meetings/`
- `sources/`

## Long-running tracking

Projects and workstreams may declare stable source bindings in Frontmatter:

```yaml
tracking_bindings:
  - provider: teams
    resource: conversation
    id: tenant-or-connector-conversation-id
tracking_aliases: [optional human name, short code]
```

Bindings are the only automatic-write authorization. A source may be listed on
multiple project/workstream pages. Runtime updates managed tracking state and
Timeline blocks, preserves user-authored prose, and creates canonical
action/decision/commitment/risk pages from structured progress signals. It never
creates a project/workstream from an unbound event.

This skill may edit project/workstream state only when the user explicitly
invokes a project-maintenance workflow. It is not called as a write-capable
sub-step of `ingest` or `meeting-ingestion`; automatic evidence processing is
owned by the company-server tracking worker.

When `state/indexes/project-tracking-review` contains a candidate, review the
evidence, add the chosen binding to the canonical page Frontmatter, then run
`VOLTMIND_RUNTIME_ROLE=company-server voltmind projects tracking reconcile
--source-id <company-source>` on the company server, or wait for the next
ingest retry.

Write additively and preserve existing user prose. If a project update could become shared team context, create a local `contribution/candidates/` draft for user review; do not publish externally in Phase 1.

## Output Format

Return the project slug, linked state objects, open threads, and any candidate contribution drafts awaiting review.

## Anti-Patterns

- Turning every small task into a project.
- Duplicating action, risk, commitment, or decision details instead of linking canonical pages.
- Writing shared/team/company state directly in Phase 1.
