---
name: maintain
version: 2.0.0
description: VoltMind MVP health, status, embedding freshness, and basic job checks.
triggers:
  - "brain health"
  - "voltmind health"
  - "doctor"
  - "status"
  - "maintenance"
  - "embedding freshness"
  - "job status"
  - "cancel job"
tools:
  - get_health
  - get_page
  - list_pages
  - get_links
  - get_backlinks
  - add_link
  - remove_link
  - add_timeline_entry
  - search
mutating: true
---

# Maintain Skill — VoltMind MVP

MVP maintenance is operationally small: verify the local runtime, keep the index
fresh, inspect basic graph context, and manage stable job queue commands.

## Allowed Commands

```bash
voltmind status
voltmind doctor
voltmind apply-migrations
voltmind sync --no-pull --no-embed
voltmind embed --stale
voltmind search "<known term>"
voltmind query "<known question>"
voltmind jobs list
voltmind jobs get <job-id>
voltmind jobs cancel <job-id>
voltmind jobs stats
```

Use `voltmind backlinks`, `voltmind timeline`, `voltmind tags`, and
`voltmind graph` for basic graph/context checks. Use MCP `get_links` through
`voltmind call` when outgoing-link inspection is required.
Use `voltmind link`, `voltmind unlink`, and `voltmind timeline-add` for
explicit corrections to agent-curated page relationships.

## Frozen Maintenance

Do not run or recommend inherited advanced maintenance in MVP:

- `dream`, `autopilot`, remediation loops, feature scores.
- Standalone historical `extract links`, `extract timeline`, or broad batch
  graph backfill commands.
- Minion submit/shell/worker/supervisor flows.
- Eval benchmarks, search-mode tuning, anomaly/salience/expert flows.
- Cloud file storage verification/migration.
- Schema evolution or skillpack checks.

If requested, report that the capability is frozen and offer the MVP-safe
alternative, usually `doctor`, `status`, `sync`, `embed --stale`, `search`, or
`query`.

## Health Flow

1. Run `voltmind status` for a human-readable summary.
2. Run `voltmind doctor` for runtime checks.
3. If pages changed on disk, run `voltmind sync --no-pull --no-embed`.
4. If retrieval is stale or chunks need vectors, run `voltmind embed --stale`.
5. Check graph materialization for a known curated page with
   `voltmind backlinks` or `voltmind graph`.
6. Verify with one known `voltmind search` or `voltmind query`.

## Graph Health Flow

For a page the agent just整理/curated:

1. Run `voltmind graph <slug> --depth 1` to inspect nearby graph context.
2. Run `voltmind backlinks <important-entity-slug>` to confirm incoming context.
3. Add missing explicit relationships with `voltmind link`.
4. Add dated evidence with `voltmind timeline-add` when useful.
5. Re-run `voltmind graph <slug> --depth 2` to verify traversal.

This per-page relationship materialization is MVP. Large historical graph
backfills stay frozen until a later phase.

## Jobs Flow

Only expose stable queue inspection/cancel commands:

```bash
voltmind jobs list
voltmind jobs get <job-id>
voltmind jobs cancel <job-id>
voltmind jobs stats
```

Do not submit new shell/subagent jobs through inherited Minion commands.

## Output Format

```text
VOLTMIND HEALTH
Status: <summary>
Doctor: <pass/fail summary>
Index: <sync/embed action taken or not needed>
Search check: <result>
Jobs: <queue summary if checked>
Frozen requests: <anything outside MVP>
```
