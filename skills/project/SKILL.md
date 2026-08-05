---
name: project
version: 1.0.0
description: Maintain durable project/workstream context and long-running source bindings, review tracking candidates, inspect tracking status, and reconcile evidence after binding changes. Use for project updates, tracking bindings, unresolved project evidence, or long-running project tracking.
triggers:
  - "project update"
  - "update project page"
  - "project context"
  - "open threads"
  - "项目更新"
  - "项目上下文"
  - "long-running project tracking"
  - "project tracking"
  - "tracking binding"
  - "bind source to project"
  - "project tracking review"
  - "长期项目追踪"
  - "项目追踪"
  - "绑定项目来源"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_timeline_entry
  - get_backlinks
  - get_timeline
  - get_project_tracking_status
  - reconcile_project_tracking
  - register_tracking_evidence
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

Bindings are the only automatic-write authorization for existing objects. A
source may be listed on multiple project/workstream pages. The client agent is
the primary semantic writer: after canonical source evidence is written, it
updates managed tracking state and Timeline, preserves user-authored prose, and
creates/updates canonical action/decision/commitment/risk pages. A new project
requires goal, owner, scope, status, and completion condition; a new workstream
requires a durable responsibility domain with no fixed end date. Ambiguous
matches go to the review index. The server does not repeat this work during
ingest.

After every client write, validate the local vault, synchronize the exact local
source and derived Markdown with remote `put_page`, then call
`register_tracking_evidence` with the event identity, client outcome, and
actual affected project/workstream/state page slugs. A review-index-only
candidate is `review_needed` with an empty `affected_pages` list.
Company-server Dream audits receipts and repairs only anomalies through the
generic subagent.

When `state/indexes/project-tracking-review` contains a candidate, review the
evidence, add the chosen binding to the canonical page Frontmatter, then run
the Host operation `reconcile_project_tracking` to request a Dream maintenance
pass. With a trusted shell directly
on the company server, the equivalent command is
`VOLTMIND_RUNTIME_ROLE=company-server voltmind projects tracking reconcile
--source-id <company-source>`. Use `get_project_tracking_status` before and
after reconciliation. Neither runtime operation adds or removes bindings.

Write additively and preserve existing user prose. If a project update could become shared team context, create a local `contribution/candidates/` draft for user review; do not publish externally in Phase 1.

## Output Format

Return the project slug, linked state objects, open threads, and any candidate contribution drafts awaiting review.

## Anti-Patterns

- Turning every small task into a project.
- Duplicating action, risk, commitment, or decision details instead of linking canonical pages.
- Writing shared/team/company state directly in Phase 1.
