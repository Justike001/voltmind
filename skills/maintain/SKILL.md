---
name: maintain
version: 2.0.0
description: |
  Router for brain health checks and maintenance. Picks maintain-client (thin
  client / cron agent) vs maintain-host (company server / full local install)
  based on the runtime, then delegates. Read this first to route, then read the
  chosen variant's SKILL.md for the workflow.
triggers:
  - "brain health"
  - "check backlinks"
  - "maintenance"
  - "orphan pages"
  - "stale pages"
  - "extract links"
  - "build link graph"
  - "populate timeline"
  - "populate links"
  - "backfill graph"
  - "extract timeline entries"
  - "run dream"
  - "process today's session"
  - "process yesterday's transcripts"
  - "synthesize my conversations"
  - "what patterns did you see"
  - "did the dream cycle run"
  - "consolidate yesterday's conversations"
  - "backfill file references"
  - "index legacy file links"
  - "scrub open paths"
  - "remove stored drive paths"
  - "补录文件引用"
  - "清理本地文件路径"
  - "project tracking health"
  - "failed tracking receipts"
  - "reconcile project tracking"
  - "项目追踪健康"
  - "修复项目追踪"
tools:
  - get_health
  - get_page
  - put_page
  - list_pages
  - get_backlinks
  - add_link
  - search
  - search_file_refs
  - backfill_file_refs
  - scrub_file_ref_open_paths
  - get_project_tracking_status
  - reconcile_project_tracking
  - register_tracking_evidence
mutating: true
---

# Maintain Skill (router)

Routes maintenance work to the runtime-appropriate skill, then executes its
workflow. **Always read the chosen skill's SKILL.md and follow it.**

## Routing decision

| Runtime | Skill to read & follow | Why |
|---|---|---|
| Thin client (OAuth MCP → remote Host), cron agent, client-scoped MCP | `skills/maintain-client/SKILL.md` | Read-only observation + client-authorized writes (evidence registration, file-ref backfill/scrub on own source, link/tag fixes on own source). Host-only work is escalated as a Host work request. |
| Company server / full local install (`VOLTMIND_RUNTIME_ROLE=company-server` or local Postgres CLI) | `skills/maintain-host/SKILL.md` | Full surface: sync, extract, embed, dream, init, apply-migrations, `doctor --remediate`, `projects tracking reconcile`, schema/RLS health, autopilot install. |

## Decide: which runtime am I?

1. **Am I a thin client?** If `voltmind init --mcp-only` was used, or
   `isThinClient(cfg)` is true (remote_mcp configured), or I am an agent
   talking to a remote Host over OAuth MCP → **maintain-client**. Host-only CLI
   (`sync/embed/extract/dream/init/apply-migrations/reconcile`) is refused on
   thin clients by `voltmind` itself — do not bypass.
2. **Am I a company server?** If this machine runs the company-brain Postgres
   engine and `VOLTMIND_RUNTIME_ROLE=company-server` (autopilot / `jobs work` /
   explicit env) → **maintain-host**.
3. **Otherwise (full local install, local PGLite or Postgres CLI owner)** →
   **maintain-host**, with the caveats in that skill about spending gates.

## After routing

- Read the chosen SKILL.md in full and follow its Phases.
- Never run host-only commands (`dream`, `extract`, `embed`, `sync`, `init`,
  `apply-migrations`, `projects tracking reconcile`, `doctor --remediate`)
  from a client runtime, and never set `VOLTMIND_RUNTIME_ROLE=company-server`
  on a client. File a Host work request instead.
- `reconcile_project_tracking` is admin-scope AND company-server-only; a client
  cannot and must not call it. Use `get_project_tracking_status` /
  `list_project_tracking_receipts` / `register_tracking_evidence` on the
  client, and escalate.

## Legacy direct workflows (when routing is not needed)

If the user explicitly asked for a dimension-by-dimension audit or a specific
maintenance action, you may run the corresponding section directly from the
chosen skill (maintain-host for full-surface dimensions, maintain-client for
client-safe ones):

- Stale pages / orphan pages / dead links / missing cross-references / back-link
  enforcement / filing rule violations / citation audit / tag consistency:
  see the chosen skill's dimension walk.
- External file-reference backfill + scrub: both skills keep the identical
  section (source-scoped, preview-before-apply).
- Long-running project tracking health: `maintain-host` for status +
  reconcile; `maintain-client` for status + review + registration + escalation.
- Dream cycle (synthesize + patterns): host-only — `maintain-host`.
- Autopilot check / install: host-only — `maintain-host`.
- Schema/RLS/init/apply-migrations: host-only — `maintain-host`.
- Benchmark Testing: both; host runs the full battery after imports/upgrades,
  client runs spot-checks.
- Report Storage: both; client report includes a **Host Work Requests** section.

## Output

Produce the maintenance report in the chosen skill's format (dimension counts
table, details, benchmark if run, outstanding issues; client adds Host work
requests).