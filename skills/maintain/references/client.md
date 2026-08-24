# Client / Thin-Client Maintenance Reference

Periodic brain health checks and cleanup — **thin-client / cron agent variant**.

## Runtime role gate

- **Thin client** (OAuth MCP pointing at a remote Host): this is the right
  reference. Read-only observation via MCP read tools; client-owned writes on your
  authorized source; everything host-only goes into the **Host work request**.
- **Full local install / company server**: stop and read [host.md](host.md)
  instead. `voltmind sync / extract / embed /
  dream / init / apply-migrations / doctor --remediate / projects tracking
  reconcile` are host-only here and are refused on thin clients by `voltmind`
  itself.

## Trust boundary (what this reference never does)

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

- The configured local semantic vault is the client's primary maintenance
  surface and source of truth. Remote MCP is an optional projection and health
  surface, not a prerequisite for local inspection or repair.
- Every in-scope local Markdown page is checked deterministically for structural
  and semantic hygiene; database-only dimensions are reported separately and
  never represented as a complete local-vault audit.
- Each issue found has a specific local fix, review action, or Host capability
  request. Do not claim a clean dimension unless the scanned scope and any
  exclusions are reported.
- Back-link iron law is enforced on client-owned writes.
- Citation format is validated against the standard.
- Long-running tracking is reviewed (status + receipts) and client-authored
  evidence is registered; resolution is requested from the Host.

## Phases

### 0. Resolve and inventory the local vault

1. Resolve the vault from the already-configured `client_vault_path` or
   `VOLTMIND_CLIENT_VAULT_PATH`. In repository-governed environments that name
   `VOLTMIND_LOCAL_BRAIN_VAULT`, resolve that variable before brain work. If no
   configured vault exists, stop and request the path; never infer, echo, or
   commit a private path.
2. Read the vault's root `index.md`, `RESOLVER.md`, `schema.md`, `README.md`, and
   relevant schema-directory README files before judging filing or page shape.
   The active schema pack and canonical page-template contract remain the
   machine authority.
3. Enumerate local Markdown files directly from the vault. Exclude `.git/`,
   `.voltmind/`, generated reports, templates, backups, binaries, and paths the
   vault resolver explicitly excludes. Do not use `list_pages` as an exhaustive
   inventory: it is a bounded remote projection, not a pageable vault walker.
4. Record the exact scan scope: files discovered, files checked, exclusions,
   parse failures, and whether this was a recent-change pass or a rotating full
   sweep. Cron runs should check files changed since the last durable local
   receipt plus a bounded rotating slice of older pages; run a full sweep on a
   slower cadence or when requested.

### 1. Optional remote health snapshot (read-only)

1. `get_brain_identity` (read scope) — version, engine kind, page/chunk counts.
2. `voltmind doctor --json` — on a thin client this runs the **remote doctor**
   (`voltmind remote doctor`) with a scope probe; report failing checks to the
   user. Key signals: connection health, schema version, RLS status, embedding
   staleness.
3. `get_project_tracking_status` + `list_project_tracking_receipts` (read) —
   source-scoped tracking health on your authorized source.
4. The full health dashboard (`voltmind health` / `voltmind stats`, embed
   coverage, stale/orphan counts) is **admin-scope** — a client cannot call it.
   If per-dimension scores are required, request them from the Host in the
   report under Host work requests (Host runs `voltmind health --json`).
5. Any host-only gap (schema behind, RLS off, embeddings stale, sync stale)
   becomes a Host work request item — do NOT run `init` / `apply-migrations` /
   `embed` from the client.
6. If network, OAuth, MCP, or the Host is unavailable, mark remote dimensions
   `unavailable` and continue the local vault audit. Remote failure must not
   turn a completed local scan into a generic maintenance failure.

### 2. Local semantic page maintenance (primary)

For every page in the recorded local scan scope, read the complete Markdown
before proposing a change. Apply deterministic checks first, then semantic
checks that require evidence-aware judgment.

#### Deterministic structure and timeline checks

- Parse YAML/frontmatter and validate the slug/path, declared type, required
  fields, canonical headings, and timeline marker against the active schema and
  page-template contract. Route focused malformed-frontmatter repair through
  `skills/frontmatter-guard/SKILL.md`; do not normalize unknown custom fields
  away.
- Parse every `## Timeline` entry. Require a real `YYYY-MM-DD` date, newest-first
  ordering across the complete section, no exact duplicate
  `{date, summary, detail}`, and a source citation for every durable event.
  Same-date order is not significant. This audit applies to existing pages;
  the local writer's preflight only protects pages when they are written again.
- Resolve Markdown links and wikilinks against the local vault. Distinguish a
  missing target from a valid alias or resolver mapping before flagging it.
- Check citations structurally and verify local page/evidence targets when the
  citation names one. Never fabricate provenance to silence a citation gap.

#### Semantic consistency checks

- Compare current `State`/compiled truth with newer cited timeline and raw
  evidence. Flag a page when current state omits, contradicts, or predates a
  material confirmed update; do not rewrite state from an inference.
- Check whether confirmed material facts in `sources/teams/`,
  `sources/meetings/`, `sources/emails/`, and `sources/calendar/` have been
  projected to the appropriate canonical person/company/project/workstream
  page or a durable clarification queue. Raw evidence itself remains unchanged.
- Detect likely duplicate canonical entities, inconsistent aliases, and filing
  that conflicts with the vault resolver or primary-subject rule. Similar names
  are review candidates, not automatic merges.
- Check meaningful person/company mentions for local reciprocal references and
  check `state/indexes/ingest-clarification-review`,
  `state/indexes/project-tracking-review`, and `state/actions/` for stale or
  contradictory status. Maintenance may flag or reconcile deterministically;
  it must not invent an answer, owner, deadline, binding, or confirmation.

#### Local-first repair path

1. Read the target page, cited evidence, and related canonical pages needed to
   justify the change.
2. Preserve raw evidence, custom frontmatter, citations, and unrelated user
   edits. Make the smallest coherent Markdown correction; do not append a
   maintenance event merely for formatting-only normalization.
3. For every canonical semantic-page change, run local
   `voltmind put <slug> < page.md`. It validates and atomically writes the exact
   Markdown to `client_vault_path` before attempting remote `put_page`.
   Direct remote `put_page`, `add_link`, `remove_link`, `add_tag`, or
   `remove_tag` is not a substitute for the local semantic write.
4. If remote synchronization fails or the automation has no network, retain
   the local write and its `local_written_remote_pending` receipt. Report the
   pending projection and retry later from the exact local file; do not create
   another semantic event during retry.
5. Never delete, merge, or refile a page without confirmation unless a separate
   deterministic workflow explicitly authorizes that operation and preserves a
   recoverable backup.

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

### 3. Remote projection dimension walk

Apply the existing database-oriented checks below only to pages the client can
see on its authorized source. Treat them as projection checks supplementing the
local semantic audit, not as exhaustive vault counts:

### Stale pages
Pages where compiled_truth is older than the latest timeline entry. The assessment hasn't been updated to reflect recent evidence.
- Use available remote health output for the stale count; if unavailable,
  report this projection dimension as unavailable rather than clean.
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
- Fix the owning local Markdown page through the local-first repair path; use a
  direct graph operation only for a relationship that is intentionally
  database-only and cannot be represented in the canonical page.
- Format: `- **YYYY-MM-DD** | Referenced in [page title](path) -- brief context`

### Filing rule violations
Check for common misfiling patterns (see `skills/_brain-filing-rules.md`):
- Content with clear primary subjects filed in `sources/` instead of the
  appropriate directory (people/, companies/, concepts/, etc.)
- Use voltmind search to find pages in `sources/` that reference specific
  people, companies, or concepts -- these may be misfiled
- Flag misfiled pages for review or re-filing

### Citation audit
Use this remote spot-check to detect projection drift after the local
deterministic citation scan:
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

Anything server-only becomes a structured list. **Do not paste exact host-only
commands here** — the client cannot run them, and the commands live in
[host.md](host.md) (single source of truth). Name the **capability** you need
and point at the relevant Host reference section:

| Capability needed | Where it's done | Client's role |
|---|---|---|
| Sync on demand | `voltmind remote ping` — **client can run this itself** (queues an autopilot-cycle job on the Host); `voltmind sync` is host-only | client runs `remote ping` |
| Embeddings stale | Host reference → Embedding freshness (or `voltmind remote ping`) | escalate; client never runs `embed` |
| Schema / RLS / migrations | Host reference → Schema health / Security (RLS) | escalate; client never runs `init`/`apply-migrations` |
| Graph extraction (links/timeline) | Host reference → Autopilot check (autopilot covers it; manual only if down) | escalate |
| Dream cycle | Host reference → Autopilot check (autopilot covers it; manual only if down) | escalate |
| Tracking reconcile | Host reference → Long-running project tracking health | escalate (client cannot call `reconcile_project_tracking`) |
| File ref backfill/scrub on a shared mount without client mapping | Host reference → External file-reference maintenance | escalate |
| Full per-dimension health scores | Host runs `voltmind health --json` | ask in report |

Ship this list to the host agent (report file, queue message, or user approval)
instead of running any of it locally. The one thing the client CAN trigger is
`voltmind remote ping` — that is a client-side convenience, not a host command.

## Report Storage

After maintenance runs, save a report:
- Local vault scan scope, exclusions, parse failures, and offline/online state
- Timeline order/duplicate/date/citation violations found and fixed
- Semantic state/evidence inconsistencies and unprojected confirmed evidence
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
- Treating bounded `list_pages` or unavailable remote health as a complete local-vault audit
- Stopping the local semantic audit merely because network/MCP is unavailable
- Calling remote `put_page` or graph/tag mutations instead of updating the authoritative local Markdown
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
| Timeline integrity   | N           | N     | N         | n     |
| Template/frontmatter | N           | N     | N         | n     |
| State/evidence drift | N           | N     | N         | n     |
| Unprojected evidence | N           | N     | N         | n     |

### Details
[Per-dimension breakdown with specific pages and actions taken]

### Local Scan Scope
[Files discovered/checked, exclusions, incremental/full-sweep mode, remote availability]

### Host Work Requests
[Required Host capabilities / reference phases, one per line]

### Benchmark Results (if run)
[Tier 1-4 query results with pass/fail]

### Outstanding Issues
[Items requiring user attention or confirmation]
```

## Tools Used

- Enumerate and read local Markdown under the resolved client vault
- Validate canonical pages through local `voltmind put`
- Check brain identity + counters (get_brain_identity)
- Check voltmind health (`voltmind doctor --json` / `voltmind remote doctor`; full
  `voltmind health` dashboard is admin-scope → Host work request)
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
