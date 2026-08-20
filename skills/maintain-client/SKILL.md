---
name: maintain-client
version: 1.0.0
description: |
  CLIENT-side brain health checks and cleanup for thin-client / cron agents:
  read-only health observation, back-link and citation spot-checks on the
  client's authorized source, client-owned file-reference backfill/scrub,
  long-running project-tracking review + evidence registration, benchmark
  spot-checks, and a Host work request for anything server-only. Use when
  asked to run maintenance on a thin client, check brain health from a
  client agent, or when the user says the cron maintenance agent may not
  run host-only commands.
triggers:
  - "brain health"
  - "check backlinks"
  - "maintenance"
  - "orphan pages"
  - "stale pages"
  - "backfill file references"
  - "index legacy file links"
  - "scrub open paths"
  - "remove stored drive paths"
  - "补录文件引用"
  - "清理本地文件路径"
  - "client maintenance"
  - "thin client maintenance"
  - "cron maintenance"
  - "客户端维护"
tools:
  - get_brain_identity
  - get_health
  - get_stats
  - search
  - query
  - get_page
  - list_pages
  - get_backlinks
  - get_timeline
  - add_link
  - remove_link
  - add_tag
  - remove_tag
  - put_page
  - search_file_refs
  - backfill_file_refs
  - scrub_file_ref_open_paths
  - get_project_tracking_status
  - list_project_tracking_receipts
  - register_tracking_evidence
mutating: true
---

# Maintain Client Skill

Periodic brain health checks and cleanup — **thin-client / cron agent variant**.

## Runtime role gate

- **Thin client** (OAuth MCP pointing at a remote Host): this is the right
  skill. Read-only observation via MCP read tools; client-owned writes on your
  authorized source; everything host-only goes into the **Host work request**.
- **Full local install / company server**: stop and read
  `skills/maintain-host/SKILL.md` instead. `voltmind sync / extract / embed /
  dream / init / apply-migrations / doctor --remediate / projects tracking
  reconcile` are host-only here and are refused on thin clients by `voltmind`
  itself.

## Trust boundary (what this skill never does)

Never attempt these from a client runtime — the server refuses them and the
threat model depends on you NOT bypassing it:

- `reconcile_project_tracking` / `voltmind projects tracking reconcile` —
  admin-scope + company-server-only (`operations.ts`). Do not fake
  `VOLTMIND_RUNTIME_ROLE=company-server`; that env var is for the company-brain
  host only. A client that needs reconcile files a Host work request.
- `voltmind dream`, `voltmind extract`, `voltmind embed`, `voltmind sync`,
  `voltmind init`, `voltmind apply-migrations`, `voltmind doctor --remediate`
  — all host CLI; thin-client routing refuses them with a hint pointing at the
  host. Escalate instead.
- Batch LLM synthesis / patterns / consolidate phases — PROTECTED_JOB_NAMES;
  MCP cannot submit them, and a client should not.
- Never mark a file reference "missing" because one client lacks a mapping or
  mount.

## Contract

- All client-visible health dimensions are checked (stale, orphan, dead links,
  cross-refs, backlinks, citations, filing, tags) and reported with counts per
  dimension — **read-only** or on pages your authorized source owns.
- Each issue found has a specific fix action, and a **host: <command>** line for
  anything only the Host can fix.
- Back-link iron law is enforced on client-owned writes.
- Citation format is validated against the standard.
- Long-running tracking is reviewed (status + receipts) and client-authored
  evidence is registered; resolution is requested from the Host.

## Phases

### 0. Health snapshot (read-only)

1. `get_brain_identity` (read scope) — version, engine kind, page/chunk counts.
2. `voltmind doctor --json` — on a thin client this runs the **remote doctor**
   (`voltmind remote doctor`) with a scope probe; report failing checks to the
   user. Key signals: connection health, schema version, RLS status, embedding
   staleness.
3. `get_health` (admin scope) — the full health dashboard. NOTE: admin-scope MCP
   clients see this filtered out of `get_skill`'s usable tools; full local
   installs reach it via `voltmind health` / `voltmind stats`. If unavailable,
   proceed with `get_brain_identity` + `doctor --json` and note the gap.
4. Any host-only gap (schema behind, RLS off, embeddings stale, sync stale)
   becomes a Host work request item — do NOT run `init` / `apply-migrations` /
   `embed` from the client.

### Long-running project tracking review + registration

1. Call `get_project_tracking_status` on your source (read scope). Review
   failed/stalled receipts and `state/indexes/project-tracking-review`.
2. Review your own client-authored evidence with `list_project_tracking_receipts`.
3. If you authored new evidence (Teams/meeting/email/calendar pages written via
   `put_page`), register it with `register_tracking_evidence` — record the
   already-existing evidence page slug, the stable provider event identity, what
   you actually did (`client_outcome`), and which pages you changed. This op
   never copies Markdown, never calls an LLM, and never edits project/workstream
   pages.
4. Bindings are corrected only in project/workstream Frontmatter through the
   project workflow — client maintenance must not invent or silently change
   bindings.
5. Anything needing a receipt audit, subagent repair, or reconcile → Host work
   request: `VOLTMIND_RUNTIME_ROLE=company-server voltmind projects tracking
   reconcile --source-id <company-source>` (company-server only). The Host
   operation queues the protected worker; it does not grant the client direct
   project-page write access.

### External file-reference maintenance (client-authorized)

Use source-scoped operations for legacy indexing and cleanup:

1. Preview `backfill_file_refs`, then apply it only after reviewing counts.
   On a thin client, `voltmind file-refs backfill --dry-run --root-key <key>`
   supplies only transient matching hints; the Host never accesses the drive.
2. Verify representative names or logical paths with `search_file_refs`.
3. Preview `scrub_file_ref_open_paths`; apply only after confirming the affected
   page/ref counts. This removes deprecated stored workstation paths and
   rebuilds logical projections.
4. Do not mark references missing because one client lacks a mapping or mount.

CLI equivalents for an agent with the client shell are:

```powershell
voltmind file-refs backfill --dry-run --root-key synology-public
voltmind file-refs backfill --root-key synology-public
voltmind file-refs scrub-open-paths --dry-run
voltmind file-refs scrub-open-paths --yes
```

### Light dimension walk

Apply the same per-dimension checks as the Host skill, but on pages your client
can see and may fix on its authorized source:

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

### Back-link enforcement
Check that the back-linking iron law is being followed:
- For each recently updated page, check if entities mentioned in it have
  corresponding back-links FROM those entity pages
- A mention without a back-link is a broken brain
- Fix: add the missing back-link to the entity's Timeline or See Also section
- Format: `- **YYYY-MM-DD** | Referenced in [page title](path) -- brief context`

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

### Open threads
Timeline items older than 30 days with unresolved action items.
- Flag for review

## Benchmark Testing (spot-check)

Periodically verify search quality hasn't regressed. Run a small battery of test
queries across difficulty tiers:

- **Tier 1 (entity lookup):** known names -- should always resolve
- **Tier 2 (topic recall):** concepts, topics -- keyword search should handle
- **Tier 3 (semantic):** queries with no exact keyword match -- needs embeddings
- **Tier 4 (cross-domain):** relational/connection queries -- only semantic handles

Compare results from `voltmind search` (keyword) vs `voltmind query` (hybrid).
Quality matters more than speed (2.5s right > 200ms wrong).

When to run spot-checks:
- After major brain imports or re-imports
- After voltmind version upgrades
- Monthly to track quality drift

## Host work request (escalation)

Anything server-only becomes a structured list. For each item, give the exact
host command or the Host skill phase to run:

- Schema / RLS / migrations: `voltmind doctor --json`, then `voltmind apply-migrations --yes` on the host
- Embeddings: `voltmind embed --stale` on the host
- Sync: `voltmind sync` / `voltmind remote ping` on the host
- Graph extraction: `voltmind extract links --source db` / `voltmind extract timeline --source db` on the host
- Dream cycle: `voltmind dream` on the host
- Tracking reconcile: `VOLTMIND_RUNTIME_ROLE=company-server voltmind projects tracking reconcile --source-id <company-source>`
- Backfill/scrub a shared mount without a client mapping: host-side `voltmind file-refs ...`

Ship this list to the host agent (report file, queue message, or user approval)
instead of running any of it locally.

## Report Storage

After maintenance runs, save a report:
- Health check results (before/after scores for each dimension the client can observe)
- Back-link violations found and fixed
- Filing rule violations found
- Citation gaps flagged
- Benchmark results (if run)
- Outstanding issues requiring user attention
- **Host work requests** (the escalation list from above)

This creates an audit trail for brain health over time.

## Quality Rules

- Never delete pages without confirmation
- Log all changes via timeline entries
- Check voltmind health before and after to show improvement
- Never invent or silently change tracking bindings

## Anti-Patterns

- Running host-only CLI from a thin client (dream/extract/embed/sync/init/apply-migrations/reconcile)
- Faking `VOLTMIND_RUNTIME_ROLE=company-server` on a client
- Fixing pages without reading them first -- you must understand context before editing
- Silently skipping dimensions -- every dimension must be checked and reported, even if clean
- Deleting orphan pages without checking if they should be linked instead
- Batch-fixing back-links without verifying the relationship is real
- Marking a dimension "clean" without actually querying it
- Rewriting compiled truth without reading the full timeline first
- Removing tags without checking if other pages use the same tag consistently
- Marking a file reference missing because one client lacks a mapping or mount

## Output Format

The maintenance report follows this structure:

```
## Brain Health Report — YYYY-MM-DD (client scope)

| Dimension           | Issues Found | Fixed | Remaining | Host? |
|----------------------|-------------|-------|-----------|-------|
| Stale pages          | N           | N     | N         | y/n   |
| Orphan pages         | N           | N     | N         | y/n   |
| Dead links           | N           | N     | N         | y/n   |
| Missing cross-refs   | N           | N     | N         | y/n   |
| Back-link violations | N           | N     | N         | y/n   |
| Citation gaps        | N           | N     | N         | y/n   |
| Filing violations    | N           | N     | N         | y/n   |
| Tag inconsistencies  | N           | N     | N         | y/n   |
| Open threads         | N           | N     | N         | y/n   |

### Details
[Per-dimension breakdown with specific pages and actions taken]

### Host Work Requests
[Exact host commands / Host skill phases required, one per line]

### Benchmark Results (if run)
[Tier 1-4 query results with pass/fail]

### Outstanding Issues
[Items requiring user attention or confirmation]
```

## Tools Used

- Check brain identity + counters (get_brain_identity)
- Check voltmind health (get_health / `voltmind doctor --json` / `voltmind remote doctor`)
- List pages in voltmind with filters (list_pages)
- Read a page from voltmind (get_page)
- Check backlinks in voltmind (get_backlinks)
- Link entities in voltmind (add_link)
- Remove links in voltmind (remove_link)
- Tag a page in voltmind (add_tag)
- Remove a tag in voltmind (remove_tag)
- View timeline in voltmind (get_timeline)
- Review project-tracking status + receipts (get_project_tracking_status / list_project_tracking_receipts)
- Register client-authored evidence (register_tracking_evidence)
- Search and backfill file references (search_file_refs / backfill_file_refs / scrub_file_ref_open_paths)