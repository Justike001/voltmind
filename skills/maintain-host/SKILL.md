---
name: maintain-host
version: 1.0.0
description: |
  HOST-side brain health checks and cleanup: back-link enforcement, citation
  audit, filing validation, stale info detection, orphan pages, external-file-
  reference backfill/path cleanup, graph population, dream cycle, autopilot
  install, schema/RLS health, and long-running project-tracking reconcile.
  Run on the company server / full local install where sync, extract, embed,
  dream, init, apply-migrations, and `reconcile_project_tracking` are legal.
  Thin-client agents MUST use maintain-client instead; this skill's CLI paths
  are refused on thin clients by `voltmind` itself.
triggers:
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
  - "get my brain to 90/100"
  - "fix what's broken"
  - "project tracking health"
  - "failed tracking receipts"
  - "reconcile project tracking"
  - "项目追踪健康"
  - "修复项目追踪"
  - "host maintenance"
  - "server brain maintenance"
  - "公司脑维护"
tools:
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

# Maintain Host Skill

Periodic brain health checks and cleanup — **host/company-server variant**.

## Runtime role gate

- Full local install or company server (Postgres + `VOLTMIND_RUNTIME_ROLE=company-server`
  where noted): this skill is the right one. `voltmind sync / extract / embed /
  dream / init / apply-migrations / doctor --remediate / projects tracking
  reconcile` are all legal here.
- **Thin client** (OAuth MCP pointing at a remote host): stop and read
  `skills/maintain-client/SKILL.md` instead. `voltmind` refuses the host-only
  CLI commands above on thin clients with a hint pointing at the host; do not
  bypass that refusal by faking an engine or setting `VOLTMIND_RUNTIME_ROLE`.
- Never set `VOLTMIND_RUNTIME_ROLE=company-server` on a client runtime. The
  company-server operations are enforced server-side (operations.ts); the env
  var is for the company-brain host only.

## Contract

This skill guarantees:
- All health dimensions are checked (stale, orphan, dead links, cross-refs, backlinks, citations, filing, tags)
- Each issue found has a specific fix action
- Back-link iron law is enforced
- Citation format is validated against the standard
- Results are reported with counts per dimension
- Long-running tracking is checked for failed/stalled receipts, stale project
  state, invalid bindings, and unresolved candidates.

## Phases
> **Autopilot already covers these every cycle** (10-min): lint, backlinks,
> sync, synthesize, extract (links+timeline), patterns, embed, orphans,
> tracking_maintenance, consolidate, takes, purge, schema-suggest. The
> phases below are the **non-duplicated** remainder — run these on a cron.


### Long-running project tracking health

> **Autopilot online?** The `tracking_maintenance` cycle phase (every 10-min
> cycle) already audits client receipts and queues generic repair for
> anomalies — manual `reconcile_project_tracking` is redundant while autopilot
> is healthy. Run it only when autopilot is down, after a binding correction,
> or to verify status.

1. Call `get_project_tracking_status` on the company Host source.
2. Review failed/stalled receipts and `state/indexes/project-tracking-review`.
3. Correct bindings only in project/workstream Frontmatter through the project
   workflow; maintenance must not invent or silently change bindings.
4. Call `reconcile_project_tracking` after a binding correction or recoverable
   failure, then verify status again. This Host operation queues the protected
   worker; it does not grant the client direct project-page write access.

For a trusted shell on the company server, use `voltmind projects tracking
status --source-id <company-source>` and, with
`VOLTMIND_RUNTIME_ROLE=company-server`, `voltmind projects tracking reconcile
--source-id <company-source>`.

### External file-reference maintenance

Use source-scoped Host operations for legacy indexing and cleanup:

1. Preview `backfill_file_refs`, then apply it only after reviewing counts.
   On a thin client, `voltmind file-refs backfill --dry-run --root-key <key>`
   supplies only transient matching hints; the Host never accesses the drive.
2. Verify representative names or logical paths with `search_file_refs`.
3. Preview `scrub_file_ref_open_paths`; apply only after confirming the affected
   page/ref counts. This removes deprecated stored workstation paths and
   rebuilds logical projections.
4. Do not mark references missing because one client lacks a mapping or mount.

CLI equivalents for an agent with the appropriate local shell are:

```powershell
voltmind file-refs backfill --dry-run --root-key synology-public
voltmind file-refs backfill --root-key synology-public
voltmind file-refs scrub-open-paths --dry-run
voltmind file-refs scrub-open-paths --yes
```

### Autonomous path (v0.36.4.0) — when you want to reach a target score

If the user asks "get my brain to 90/100" or "fix what's broken", prefer the
one-command loop over walking each dimension by hand:

```bash
voltmind doctor --remediation-plan --json              # preview what would run
voltmind doctor --remediate --yes --target-score 90 --max-usd 5
```

`--remediation-plan` prints a dependency-ordered list (sync before extract,
embed after consolidate, etc.) with per-step `est_seconds` and `est_usd_cost`.
`--remediate` walks the plan, submitting each step as a Minion job, re-checking
score between every step. `--max-usd N` is a hard cost cap — submission refuses
when the plan would exceed the cap (prevents synthesize loops from burning
Anthropic credits unattended).

When the target score is unreachable for the brain (empty brain with no entity
pages → `graph_coverage` caps at 70; unconfigured embedding key → caps at 60),
the command bails with a list of what's missing rather than looping.

Use the per-dimension walk below (Phase 2 onward) when:
- The user explicitly asks for a dimension-by-dimension audit
- You're investigating why score is stuck below `--remediate`'s ceiling
- A specific dimension needs manual judgment that the auto path skips

### Manual path

1. **Run health check.** Check voltmind health to get the dashboard.
2. **Check each dimension:**

### Stale pages
Pages where compiled_truth is older than the latest timeline entry. The assessment hasn't been updated to reflect recent evidence.
- Check the health output for stale page count
- For each stale page: read the page from voltmind, review timeline, determine if compiled_truth needs rewriting

### Orphan pages
Pages with zero inbound links. Nobody references them.
- Review orphans: are they genuinely isolated or just missing links?
- Add links in voltmind from related pages or flag for deletion

### Dead links
Links pointing to pages that don't exist.
- Remove dead links in voltmind

### Missing cross-references
Pages that mention entity names but don't have formal links.
- Read compiled_truth from voltmind, extract entity mentions, create links in voltmind

### Autopilot check
Verify autopilot is running:
```bash
voltmind autopilot --status
voltmind autopilot --status --json     # full report: overall, heartbeat_stale, business_ready, scheduler state
```
The `--status` exit code is trustworthy for gating: 0 fresh (or nothing
installed), 1 needs attention (stale heartbeat, never ran, or paused by a
migration), 2 the daemon disabled itself (its repo path vanished). `--json`
emits the full report (state, heartbeat_stale, business_ready, paused_reason,
disabled_reason). Status reads only the filesystem, so it works even when the
database is down.
If not running, install it:
```bash
voltmind autopilot --install --repo ~/brain
```
Autopilot runs sync, extract, and embed in a continuous loop with adaptive scheduling.
In v0.11.1+, autopilot dispatches each cycle as a single `autopilot-cycle`
Minion job and supervises the worker child — one install step gives you
sync + extract + embed + backlinks + durable job processing.

### Fix a half-migrated install
A v0.11.0 install where the migration skill never fired leaves Minions
partially set up: schema is applied, but `~/.voltmind/preferences.json`
doesn't exist, autopilot runs inline, host manifests still reference
`agentTurn`. Repair:

```bash
# Check migration status
voltmind apply-migrations --list

# Apply pending migrations (idempotent; safe on healthy installs)
voltmind apply-migrations --yes

# If host-specific handlers are flagged in ~/.voltmind/migrations/pending-host-work.jsonl:
# walk them per skills/migrations/v0.11.0.md + docs/guides/plugin-handlers.md,
# ship handler registrations in the host repo, then re-run apply-migrations.
```

Full troubleshooting guide: `docs/guides/minions-fix.md`.

### Filing rule violations
Check for common misfiling patterns (see `skills/_brain-filing-rules.md`):
- Content with clear primary subjects filed in `sources/` instead of the
  appropriate directory (people/, companies/, concepts/, etc.)
- Use voltmind search to find pages in `sources/` that reference specific
  people, companies, or concepts -- these may be misfiled
- Flag misfiled pages for review or re-filing

### Citation audit
Spot-check pages for missing `[Source: ...]` citations:
- Read 5-10 recently updated pages
- Check that compiled truth (above the line) has inline citations
- Check that timeline entries have source attribution
- Flag pages where facts appear without provenance

### Tag consistency
Inconsistent tagging (e.g., "vc" vs "venture-capital", "ai" vs "artificial-intelligence").
- Standardize to the most common variant using voltmind tag operations

### Feature adoption check (weekly)

Run `voltmind features --json` — scan for underused features + recommendations.
Run weekly alongside lint. Surfaces missing embeddings, unused integrations, and
configuration improvements.

### Security (RLS verification)
Run `voltmind doctor --json` and check the RLS status.
All tables should show RLS enabled. If not, run `voltmind init` again.

### Schema health
Check that the schema version is up to date. `voltmind doctor --json` reports
the current version vs expected. If behind, `voltmind init` runs migrations
automatically.

### File storage health
Check the integrity of stored files and redirect pointers:
- Run `voltmind files verify` to check all DB records have valid data
- Run `voltmind files status` to see migration state (local, mirrored, redirected)
- Check for orphan `.redirect.yaml` pointers that reference missing storage files
- Check for large binary files (>= 100 MB) still in git that should be in cloud storage
- If storage backend is configured: verify redirect pointers resolve (download test)

### Open threads
Timeline items older than 30 days with unresolved action items.
- Flag for review

### Long-running project tracking

Run tracking diagnostics against the company-brain server with an explicit
source. Do not run a client-local/default-source reconciliation:

```bash
voltmind projects tracking status --source-id <company-source>
VOLTMIND_RUNTIME_ROLE=company-server \
  voltmind projects tracking reconcile --source-id <company-source>
```

The status view is source-scoped. Reconcile requests a
`tracking_maintenance` Dream phase; it audits client registrations and queues
the generic subagent only for incomplete/ambiguous records. Before receipt
audit it deterministically sweeps canonical `sources/teams/`,
`sources/meetings/`, `sources/emails/`, and `sources/calendar/` pages for
stable evidence identities with no matching receipt, records a pending
`registration_missing` audit reason, and then routes that anomaly through the
same repair path. It never modifies
`tracking_bindings` and does not replay the removed real-time worker.

Also verify:

- the server uses Postgres and runs either
  `voltmind autopilot --runtime-role company-server` or
  `voltmind jobs work --runtime-role company-server`;
- no failed/dead `tracking_maintenance` or compatibility `project_track_progress`
  jobs are stranded;
- the last successful receipt is at least as new as the latest bound evidence;
- `tracking_bindings` still refer to live connector resources;
- `state/indexes/project-tracking-review` candidates are being reviewed.

Company-server Dream is the repair/audit executor after client writes. It does
not replace client semantic classification; it only repairs receipt anomalies
and records source-scoped maintenance outcomes.

## Benchmark Testing

Periodically verify search quality hasn't regressed. Run a battery of test
queries across difficulty tiers:

- **Tier 1 (entity lookup):** known names -- should always resolve
- **Tier 2 (topic recall):** concepts, topics -- keyword search should handle
- **Tier 3 (semantic):** queries with no exact keyword match -- needs embeddings
- **Tier 4 (cross-domain):** relational/connection queries -- only semantic handles

Compare results from `voltmind search` (keyword) vs `voltmind query` (hybrid).
Quality matters more than speed (2.5s right > 200ms wrong).

When to run benchmarks:
- After major brain imports or re-imports
- After voltmind version upgrades
- After embedding regeneration
- Monthly to track quality drift

## Heartbeat Integration

For production agents running on a schedule, integrate voltmind health checks into
your operational heartbeat.

### On every heartbeat (hourly or per-session)

Run `voltmind doctor --json` and check for degradation. Report any failing checks
to the user. Key signals: connection health, schema version, RLS status, embedding
staleness.

### Weekly maintenance

Run `voltmind embed --stale` to refresh embeddings for pages that have changed since
their last embedding. For large brains (>5000 pages), on macOS/Linux run this with `nohup`:
```bash
nohup voltmind embed --stale > /tmp/voltmind-embed.log 2>&1 &
```
On Windows, use the PowerShell `Start-Process` pattern from **Embedding
freshness** above.

### Daily verification

Verify sync is running: check `voltmind stats` and confirm `last_sync` is within
the last 24 hours. If sync has stopped, the brain is drifting from the repo.

### Stale compiled truth detection

Flag pages where compiled truth is >30 days old but the timeline has recent entries.
This means new evidence exists that hasn't been synthesized. These pages need a
compiled truth rewrite (see the maintain workflow above).

## Report Storage

After maintenance runs, save a report:
- Health check results (before/after scores for each dimension)
- Back-link violations found and fixed
- Filing rule violations found
- Citation gaps flagged
- Benchmark results (if run)
- Outstanding issues requiring user attention

This creates an audit trail for brain health over time.

## Quality Rules

- Never delete pages without confirmation
- Log all changes via timeline entries
- Check voltmind health before and after to show improvement

## Anti-Patterns

- Fixing pages without reading them first -- you must understand context before editing
- Silently skipping dimensions -- every dimension must be checked and reported, even if clean
- Deleting orphan pages without checking if they should be linked instead
- Running embedding refresh during peak usage hours
- Batch-fixing back-links without verifying the relationship is real
- Marking a dimension "clean" without actually querying it
- Rewriting compiled truth without reading the full timeline first
- Removing tags without checking if other pages use the same tag consistently

## Output Format

The maintenance report follows this structure:

```
## Brain Health Report — YYYY-MM-DD

| Dimension           | Issues Found | Fixed | Remaining |
|----------------------|-------------|-------|-----------|
| Stale pages          | N           | N     | N         |
| Orphan pages         | N           | N     | N         |
| Dead links           | N           | N     | N         |
| Missing cross-refs   | N           | N     | N         |
| Back-link violations | N           | N     | N         |
| Citation gaps        | N           | N     | N         |
| Filing violations    | N           | N     | N         |
| Tag inconsistencies  | N           | N     | N         |
| Embedding staleness  | N           | N     | N         |
| Security (RLS)       | N           | N     | N         |
| Schema health        | N           | N     | N         |
| File storage         | N           | N     | N         |
| Open threads         | N           | N     | N         |

### Details
[Per-dimension breakdown with specific pages and actions taken]

### Benchmark Results (if run)
[Tier 1-4 query results with pass/fail]

### Outstanding Issues
[Items requiring user attention or confirmation]
```

## Tools Used

- Check voltmind health (get_health)
- List pages in voltmind with filters (list_pages)
- Read a page from voltmind (get_page)
- Check backlinks in voltmind (get_backlinks)
- Link entities in voltmind (add_link)
- Remove links in voltmind (remove_link)
- Tag a page in voltmind (add_tag)
- Remove a tag in voltmind (remove_tag)
- View timeline in voltmind (get_timeline)
