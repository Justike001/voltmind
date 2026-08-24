---
name: maintain
version: 2.0.0
description: |
  Maintain brain health and semantic page quality. Routes thin-client and
  offline cron work to the local-vault client reference, and company-server or
  full-install work to the Host reference, while preserving runtime trust
  boundaries.
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
  - "get my brain to 90/100"
  - "fix what's broken"
  - "client maintenance"
  - "thin client maintenance"
  - "cron maintenance"
  - "客户端维护"
  - "host maintenance"
  - "server brain maintenance"
  - "公司脑维护"
  - "项目追踪健康"
  - "修复项目追踪"
tools:
  - get_brain_identity
  - get_health
  - get_stats
  - run_doctor
  - get_page
  - put_page
  - list_pages
  - get_backlinks
  - get_timeline
  - add_link
  - remove_link
  - add_tag
  - remove_tag
  - search
  - query
  - search_file_refs
  - backfill_file_refs
  - scrub_file_ref_open_paths
  - get_project_tracking_status
  - list_project_tracking_receipts
  - reconcile_project_tracking
  - register_tracking_evidence
mutating: true
---

# Maintain Skill

Routes maintenance work to the runtime-appropriate reference, then executes its
workflow. **Read only the selected reference in full before acting.**

## Contract

- Select exactly one runtime reference before mutation; do not mix client and
  Host authority in one maintenance pass.
- Preserve the runtime trust boundary, source routing, citations, backlinks,
  recoverability, and user-owned edits.
- Thin-client maintenance treats the local semantic vault as authoritative and
  continues offline; Host maintenance owns database-wide repair and protected
  phases.
- Report the scope actually checked. Never call a bounded sample or unavailable
  projection a complete audit.

## Routing decision

| Runtime | Reference to read & follow | Why |
|---|---|---|
| Thin client (OAuth MCP → remote Host), offline/local cron agent, client-scoped MCP | [references/client.md](references/client.md) | Local Markdown semantic maintenance first; optional remote observation and client-authorized synchronization; Host-only work becomes a capability request. |
| Company server / full local install (`VOLTMIND_RUNTIME_ROLE=company-server` or local Postgres/PGLite CLI) | [references/host.md](references/host.md) | Full surface: sync, extract, embed, dream, init, apply-migrations, `doctor --remediate`, tracking reconcile, schema/RLS health, autopilot install. |

## Decide: which runtime am I?

1. **Am I a thin client?** If `voltmind init --mcp-only` was used, or
   `isThinClient(cfg)` is true (remote_mcp configured), or I am an agent
   talking to a remote Host over OAuth MCP, or this is a Codex automation whose
   durable surface is a local semantic vault → read the **client reference**.
   Host-only CLI
   (`sync/embed/extract/dream/init/apply-migrations/reconcile`) is refused on
   thin clients by `voltmind` itself — do not bypass.
2. **Am I a company server?** If this machine runs the company-brain Postgres
   engine and `VOLTMIND_RUNTIME_ROLE=company-server` (autopilot / `jobs work` /
   explicit env) → read the **Host reference**.
3. **Otherwise (full local install, local PGLite or Postgres CLI owner)** →
   read the **Host reference**, with its spending-gate caveats.

## After routing

- Read the chosen reference in full and follow its phases.
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
maintenance action, use the corresponding section in the selected reference:

- Stale pages / orphan pages / dead links / missing cross-references / filing
  rule violations / citation audit / tag consistency:
  see its dimension walk. (Host back-link enforcement is covered by
  autopilot's `backlinks` phase — no manual cron needed.)
- External file-reference backfill + scrub: both references keep the identical
  section (source-scoped, preview-before-apply).
- Long-running project tracking health: Host reference for status + reconcile;
  client reference for local review + registration + capability request.
- Dream cycle (synthesize + patterns): autopilot's `synthesize`/`patterns`
  phases already run it every cycle. Only run `voltmind dream` manually when
  autopilot is down.
- Autopilot check / install: Host reference only.
- Schema/RLS/init/apply-migrations: Host reference only.
- Benchmark Testing: both; host runs the full battery after imports/upgrades,
  client runs spot-checks.
- Report Storage: both; client report includes a **Host Work Requests** section.

## Output Format

Produce the maintenance report in the chosen reference's format (dimension counts
table, details, benchmark if run, outstanding issues; client adds Host work
requests).

## Anti-Patterns

- Loading both references and blending their permissions without first routing
- Treating a client as a reduced Host instead of maintaining its local semantic vault
- Running Host-only commands or protected phases from a thin client
- Using remote MCP page/link/tag mutations as a replacement for local-first semantic writes
- Claiming all dimensions clean when only a sample or remote projection was checked
